//+------------------------------------------------------------------+
//|                                             ZenCopyTrader.mq5    |
//|                        Copyright 2026, Zenvest CopyTrader Team   |
//|                                             https://zenvest.io   |
//+------------------------------------------------------------------+
#property copyright "Copyright 2026, Zenvest CopyTrader Team"
#property link      "https://zenvest.io"
#property version   "1.10"
#property description "Production MT5 Real Data Bridge & Trade Copier EA for Zenvest Dashboard"

#include <Trade\Trade.mqh>
CTrade trade;

//--- Input Parameters
input string   InpServerURL      = "http://localhost:3000/api/ea/sync"; // Zenvest Dashboard Webhook URL
input string   InpAPIToken       = "";                                  // Shared API Token (must match server's EA_API_TOKEN)
enum ENUM_ROLE { ROLE_MASTER, ROLE_SLAVE };
input ENUM_ROLE InpAccountRole   = ROLE_SLAVE;                          // Account Role (MASTER / SLAVE)
input double   InpLotMultiplier  = 1.0;                                 // Lot Multiplier Ratio
input double   InpMaxSpreadPips  = 3.0;                                 // Maximum Allowed Spread (Pips)

//--- Global Variables
datetime lastSyncTime = 0;
int lastPingMs = 0; // Real measured round-trip time to the dashboard, updated after each sync

//--- Master-ticket -> local-ticket mapping, so CLOSE commands can find what to close
ulong g_masterTickets[];
ulong g_localTickets[];

void RememberCopiedPosition(ulong masterTicket, ulong localTicket)
{
   int n = ArraySize(g_masterTickets);
   ArrayResize(g_masterTickets, n + 1);
   ArrayResize(g_localTickets, n + 1);
   g_masterTickets[n] = masterTicket;
   g_localTickets[n] = localTicket;
}

ulong FindLocalTicket(ulong masterTicket)
{
   for (int i = 0; i < ArraySize(g_masterTickets); i++)
      if (g_masterTickets[i] == masterTicket) return g_localTickets[i];
   return 0;
}

void ForgetMasterTicket(ulong masterTicket)
{
   for (int i = 0; i < ArraySize(g_masterTickets); i++)
   {
      if (g_masterTickets[i] == masterTicket)
      {
         for (int j = i; j < ArraySize(g_masterTickets) - 1; j++)
         {
            g_masterTickets[j] = g_masterTickets[j + 1];
            g_localTickets[j] = g_localTickets[j + 1];
         }
         ArrayResize(g_masterTickets, ArraySize(g_masterTickets) - 1);
         ArrayResize(g_localTickets, ArraySize(g_localTickets) - 1);
         return;
      }
   }
}

//+------------------------------------------------------------------+
//| Minimal JSON helpers for parsing this dashboard's own responses  |
//| (MQL5 has no built-in JSON support; this targets our fixed shape) |
//+------------------------------------------------------------------+
string JsonGetRawValue(const string &json, const string key)
{
   string searchKey = "\"" + key + "\":";
   int pos = StringFind(json, searchKey);
   if (pos < 0) return "";
   pos += StringLen(searchKey);
   int len = StringLen(json);

   if (pos >= len) return "";
   ushort ch = StringGetCharacter(json, pos);
   if (ch == '"')
   {
      int endPos = StringFind(json, "\"", pos + 1);
      if (endPos < 0) return "";
      return StringSubstr(json, pos + 1, endPos - pos - 1);
   }

   int endPos = pos;
   while (endPos < len)
   {
      ushort c = StringGetCharacter(json, endPos);
      if (c == ',' || c == '}' || c == ']') break;
      endPos++;
   }
   return StringSubstr(json, pos, endPos - pos);
}

double JsonGetNumber(const string &json, const string key)
{
   return StringToDouble(JsonGetRawValue(json, key));
}

string JsonGetString(const string &json, const string key)
{
   return JsonGetRawValue(json, key);
}

// Splits a top-level JSON array of objects (matched by brace depth) into individual object strings
int JsonExtractArrayObjects(const string &json, const string arrayKey, string &objects[])
{
   ArrayResize(objects, 0);
   string searchKey = "\"" + arrayKey + "\":[";
   int start = StringFind(json, searchKey);
   if (start < 0) return 0;
   start += StringLen(searchKey);
   int closeBracket = StringFind(json, "]", start);
   if (closeBracket < 0) return 0;

   string inner = StringSubstr(json, start, closeBracket - start);
   int depth = 0;
   int objStart = -1;
   int count = 0;
   int ilen = StringLen(inner);
   for (int i = 0; i < ilen; i++)
   {
      ushort c = StringGetCharacter(inner, i);
      if (c == '{')
      {
         if (depth == 0) objStart = i;
         depth++;
      }
      else if (c == '}')
      {
         depth--;
         if (depth == 0 && objStart >= 0)
         {
            count++;
            ArrayResize(objects, count);
            objects[count - 1] = StringSubstr(inner, objStart, i - objStart + 1);
            objStart = -1;
         }
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| Executes OPEN/CLOSE/CLOSE_ALL commands the dashboard queued for  |
//| this account, mirroring the master's real trades onto this one   |
//+------------------------------------------------------------------+
void ProcessCommands(const string &responseJson)
{
   string commandObjects[];
   int count = JsonExtractArrayObjects(responseJson, "commands", commandObjects);

   for (int i = 0; i < count; i++)
   {
      string cmd = commandObjects[i];
      string action = JsonGetString(cmd, "action");

      if (action == "OPEN")
      {
         ulong masterTicket = (ulong)JsonGetNumber(cmd, "masterTicket");
         string symbol = JsonGetString(cmd, "symbol");
         string typeStr = JsonGetString(cmd, "type");
         double volume = JsonGetNumber(cmd, "volume");
         double sl = JsonGetNumber(cmd, "sl");
         double tp = JsonGetNumber(cmd, "tp");

         if (volume <= 0 || symbol == "") continue;
         if (FindLocalTicket(masterTicket) != 0) continue; // already copied

         if (!SymbolSelect(symbol, true))
         {
            Print("Copy OPEN failed for master #", masterTicket, ": symbol ", symbol, " not available on this broker/account");
            continue;
         }

         // Broker lot constraints differ from the master's — round to this symbol's real step/min/max
         double volStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
         double volMin = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
         double volMax = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
         if (volStep > 0) volume = MathRound(volume / volStep) * volStep;
         volume = MathMax(volMin, MathMin(volMax, volume));

         double spreadPips = (SymbolInfoDouble(symbol, SYMBOL_ASK) - SymbolInfoDouble(symbol, SYMBOL_BID)) / SymbolInfoDouble(symbol, SYMBOL_POINT) / 10.0;
         if (spreadPips > InpMaxSpreadPips)
         {
            Print("Copy OPEN skipped for master #", masterTicket, ": spread ", spreadPips, " pips exceeds guard");
            continue;
         }

         bool ok = false;
         if (typeStr == "BUY")
            ok = trade.Buy(volume, symbol, 0, sl, tp, "ZenCopy#" + IntegerToString((long)masterTicket));
         else if (typeStr == "SELL")
            ok = trade.Sell(volume, symbol, 0, sl, tp, "ZenCopy#" + IntegerToString((long)masterTicket));

         if (ok)
         {
            ulong localTicket = trade.ResultOrder();
            RememberCopiedPosition(masterTicket, localTicket);
            Print("Copied OPEN: master #", masterTicket, " -> local #", localTicket, " ", typeStr, " ", volume, " ", symbol);
         }
         else
         {
            Print("Copy OPEN failed for master #", masterTicket, ": ", trade.ResultRetcodeDescription());
         }
      }
      else if (action == "CLOSE")
      {
         ulong masterTicket = (ulong)JsonGetNumber(cmd, "masterTicket");
         ulong localTicket = FindLocalTicket(masterTicket);
         if (localTicket != 0 && PositionSelectByTicket(localTicket))
         {
            if (trade.PositionClose(localTicket))
               Print("Copied CLOSE: master #", masterTicket, " -> local #", localTicket);
            else
               Print("Copy CLOSE failed for local #", localTicket, ": ", trade.ResultRetcodeDescription());
         }
         ForgetMasterTicket(masterTicket);
      }
      else if (action == "CLOSE_ALL")
      {
         int total = PositionsTotal();
         for (int p = total - 1; p >= 0; p--)
         {
            ulong ticket = PositionGetTicket(p);
            if (ticket > 0) trade.PositionClose(ticket);
         }
         ArrayResize(g_masterTickets, 0);
         ArrayResize(g_localTickets, 0);
         Print("Executed CLOSE_ALL command from dashboard.");
      }
   }
}

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("ZenCopyTrader Real EA Initialized on MT5 Account: ", AccountInfoInteger(ACCOUNT_LOGIN), " Role: ", (InpAccountRole == ROLE_MASTER ? "MASTER" : "SLAVE"));
   EventSetTimer(1); // Set 1-second timer for real-time telemetry sync
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("ZenCopyTrader EA Offline.");
}

//+------------------------------------------------------------------+
//| Expert timer function (Real Telemetry Sync)                      |
//+------------------------------------------------------------------+
void OnTimer()
{
   SyncRealMT5Data();
}

//+------------------------------------------------------------------+
//| Extract Real Active Positions & Push Account State to Dashboard  |
//+------------------------------------------------------------------+
void SyncRealMT5Data()
{
   long   accountNo  = AccountInfoInteger(ACCOUNT_LOGIN);
   double balance    = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity     = AccountInfoDouble(ACCOUNT_EQUITY);
   double margin     = AccountInfoDouble(ACCOUNT_MARGIN);
   double freeMargin = AccountInfoDouble(ACCOUNT_FREEMARGIN);
   string serverName = AccountInfoString(ACCOUNT_SERVER);
   string company    = AccountInfoString(ACCOUNT_COMPANY);
   string roleStr    = (InpAccountRole == ROLE_MASTER) ? "MASTER" : "SLAVE";

   // Extract real active positions in MT5
   string positionsJson = "[";
   int totalPositions = PositionsTotal();
   int count = 0;

   for (int i = 0; i < totalPositions; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if (ticket > 0)
      {
         string symbol = PositionGetString(POSITION_SYMBOL);
         long typeInt  = PositionGetInteger(POSITION_TYPE);
         double volume = PositionGetDouble(POSITION_VOLUME);
         double openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
         double currentPrice = PositionGetDouble(POSITION_PRICE_CURRENT);
         double sl = PositionGetDouble(POSITION_SL);
         double tp = PositionGetDouble(POSITION_TP);
         double pnl = PositionGetDouble(POSITION_PROFIT);

         string typeStr = (typeInt == POSITION_TYPE_BUY) ? "BUY" : "SELL";

         if (count > 0) positionsJson += ",";
         positionsJson += StringFormat(
            "{\"ticket\":%I64u,\"symbol\":\"%s\",\"type\":\"%s\",\"volume\":%.2f,\"openPrice\":%.5f,\"currentPrice\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"pnl\":%.2f}",
            ticket, symbol, typeStr, volume, openPrice, currentPrice, sl, tp, pnl
         );
         count++;
      }
   }
   positionsJson += "]";

   // Real closed win/loss counts from actual MT5 account deal history (Master only, used for Win Rate %)
   string closedStatsJson = "null";
   if (InpAccountRole == ROLE_MASTER)
   {
      int wins = 0, losses = 0;
      if (HistorySelect(0, TimeCurrent()))
      {
         int totalDeals = HistoryDealsTotal();
         for (int d = 0; d < totalDeals; d++)
         {
            ulong dealTicket = HistoryDealGetTicket(d);
            if (dealTicket == 0) continue;
            if ((long)HistoryDealGetInteger(dealTicket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

            double dealProfit = HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
                               + HistoryDealGetDouble(dealTicket, DEAL_SWAP)
                               + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
            if (dealProfit > 0) wins++;
            else if (dealProfit < 0) losses++;
         }
      }
      closedStatsJson = StringFormat("{\"wins\":%d,\"losses\":%d}", wins, losses);
   }

   string jsonPayload = StringFormat(
      "{\"accountNumber\":\"%I64u\",\"role\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"freeMargin\":%.2f,\"server\":\"%s\",\"broker\":\"%s\",\"positions\":%s,\"closedStats\":%s,\"pingMs\":%d}",
      accountNo, roleStr, balance, equity, margin, freeMargin, serverName, company, positionsJson, closedStatsJson, lastPingMs
   );

   char data[];
   char result[];
   string result_headers;
   StringToCharArray(jsonPayload, data, 0, StringLen(jsonPayload));

   string headers = "Content-Type: application/json\r\nX-EA-Key: " + InpAPIToken + "\r\n";

   // Real round-trip latency measured against this dashboard's own sync endpoint
   uint requestStart = GetTickCount();
   int res = WebRequest("POST", InpServerURL, headers, 3000, data, result, result_headers);
   lastPingMs = (int)(GetTickCount() - requestStart);

   if (res == 200)
   {
      // Role is decided on the dashboard now, not by InpAccountRole, so always check for commands:
      // the server only ever queues them for accounts it has classified as Slave, so this is a
      // no-op for a real Master account regardless of what this input happens to be set to.
      string responseJson = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      ProcessCommands(responseJson);
   }
   else if (res == -1)
   {
      Print("WebRequest Error: Please add ", InpServerURL, " in MT5 -> Tools -> Options -> Expert Advisors -> Allow WebRequest for listed URL");
   }
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   double spreadPips = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / _Point / 10.0;
   if (spreadPips > InpMaxSpreadPips)
   {
      return; // Spread guard pause
   }
}
//+------------------------------------------------------------------+
