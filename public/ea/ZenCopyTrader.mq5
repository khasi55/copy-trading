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
      "{\"accountNumber\":\"%d\",\"role\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"freeMargin\":%.2f,\"server\":\"%s\",\"broker\":\"%s\",\"positions\":%s,\"closedStats\":%s,\"pingMs\":%d}",
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
      // Telemetry synced successfully
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
