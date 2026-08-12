using { smart.retail as db } from '../db/schema';

/**
 * Read-only analytical surface over the operational data.
 *
 * The aggregate views here are plain CDS projections rather than hand-written
 * SQL so they compile unchanged against SQLite locally and SAP HANA Cloud in
 * production. Fiori Elements reads its shape from this service's metadata; the
 * UI annotations live in `srv/annotations/`.
 */
// Open, for the same reason as AIService - see the note there.
@path: '/analytics'
service AnalyticsService @(requires: 'any') {

  @readonly entity Stores        as projection on db.Stores;
  @readonly entity PosSystems    as projection on db.PosSystems;
  @readonly entity Articles      as projection on db.Articles;
  @readonly entity ArticleGroups as projection on db.ArticleGroups;
  @readonly entity Suppliers     as projection on db.Suppliers;
  @readonly entity Customers     as projection on db.Customers;

  @readonly entity HourlySales   as projection on db.HourlySales;
  // Both this and ChannelMix project Receipts; name this one as the target so
  // associations pointing at Receipts resolve here rather than at the aggregate.
  @cds.redirection.target
  @readonly entity Receipts      as projection on db.Receipts;
  @readonly entity Cancellations as projection on db.Cancellations;
  @readonly entity Returns       as projection on db.Returns;
  @readonly entity PaymentFacts  as projection on db.PaymentFacts;
  @readonly entity Inventory     as projection on db.InventorySnapshots;
  @readonly entity Footfall      as projection on db.FootfallReadings;
  @readonly entity SensorReadings as projection on db.ShelfSensorReadings;

  /** Daily sales per store - the backbone of the trading dashboard. */
  @readonly
  entity DailySales as
    select from db.HourlySales {
      key businessDate,
      key store.ID     as storeId,
          store.name   as storeName,
          store.format as storeFormat,
          sum(quantity)    as quantity    : Decimal(13,3),
          sum(netRevenue)  as netRevenue  : Decimal(15,2),
          sum(vatAmount)   as vatAmount   : Decimal(15,2),
          sum(grossAmount) as grossAmount : Decimal(15,2),
    }
    group by businessDate, store.ID, store.name, store.format;

  /**
   * The trading-hour heatmap. This is the shape that makes an SAP campus store
   * legible: a hard lunch peak on weekdays and almost nothing at the weekend.
   */
  @readonly
  entity SalesByHour as
    select from db.HourlySales {
      key store.ID   as storeId,
      key hourOfDay,
      key dayOfWeek,
          store.name as storeName,
          sum(quantity)    as quantity    : Decimal(13,3),
          sum(grossAmount) as grossAmount : Decimal(15,2),
          count(*)         as dataPoints  : Integer,
    }
    group by store.ID, store.name, hourOfDay, dayOfWeek;

  /** Article performance, ranked. Feeds the assortment dashboard. */
  @readonly
  entity ArticlePerformance as
    select from db.HourlySales {
      key article.ID          as articleId,
      key store.ID            as storeId,
          article.name        as articleName,
          article.abcClass    as abcClass,
          article.group.name  as groupName,
          article.group.category as category,
          article.group.tempZone as tempZone,
          store.name          as storeName,
          sum(quantity)       as unitsSold   : Decimal(13,3),
          sum(netRevenue)     as netRevenue  : Decimal(15,2),
          sum(grossAmount)    as grossAmount : Decimal(15,2),
    }
    group by article.ID, article.name, article.abcClass, article.group.name,
             article.group.category, article.group.tempZone, store.ID, store.name;

  /** Terminal mix: how much trade each checkout type carries. */
  @readonly
  entity ChannelMix as
    select from db.Receipts {
      key store.ID          as storeId,
      key posSystem.ID      as posSystemId,
          store.name        as storeName,
          posSystem.name    as posSystemName,
          posSystem.kind    as posKind,
          count(*)          as receiptCount : Integer,
          sum(grossAmount)  as grossAmount  : Decimal(15,2),
          avg(dwellSeconds) as avgDwellSeconds : Decimal(9,2),
          avg(itemCount)    as avgBasketSize   : Decimal(9,2),
    }
    group by store.ID, store.name, posSystem.ID, posSystem.name, posSystem.kind;
}
