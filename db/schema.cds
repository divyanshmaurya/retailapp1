namespace smart.retail;

using { managed, Currency, Country } from '@sap/cds/common';
using { smart.retail.recordKey } from './common';

/**
 * Core operational model for the S.Mart autonomous store network.
 *
 * Master data and the sales/loss facts in this file are reconciled against the
 * SAP Customer Checkout "Complete Sales Report" export: the Walldorf store's
 * figures are the real exported values, the remaining stores are synthesized
 * from the same behavioural profile. `Articles.isFromSapExport` and
 * `Stores.isReferenceStore` mark which rows trace back to the export.
 */

// ---------------------------------------------------------------------------
// Master data
// ---------------------------------------------------------------------------

type StoreFormat  : String(20) enum { AUTONOMOUS; CONVENIENCE; CAMPUS_KIOSK; FLAGSHIP };
type PosKind      : String(20) enum { RFID_AUTONOMOUS; SELF_CHECKOUT; MOBILE; ASSISTED };
type TempZone     : String(20) enum { AMBIENT; CHILLED; FROZEN; HOT };
type AbcClass     : String(1)  enum { A; B; C };

entity Stores : managed {
  key ID              : String(10);
      name            : String(60);
      format          : StoreFormat;
      city            : String(40);
      country         : Country;
      /** Square metres of selling space - drives density KPIs. */
      salesArea       : Decimal(8,2);
      /** Autonomous stores trade around the clock; staffed ones do not. */
      opensAt         : Integer;
      closesAt        : Integer;
      /** True for SmartStoreWalldorf, whose facts come from the SAP export. */
      isReferenceStore : Boolean default false;
      latitude        : Decimal(9,6);
      longitude       : Decimal(9,6);
      /** Employees badging in on the campus this store serves. */
      catchmentSize   : Integer;
      posSystems      : Composition of many PosSystems on posSystems.store = $self;
}

entity PosSystems : managed {
  key ID          : String(10);
      name        : String(40);
      store       : Association to Stores;
      kind        : PosKind;
      vendor      : String(40);
      /** RFID readers and vision rigs report a health score; 100 = nominal. */
      healthScore : Integer default 100;
}

entity Suppliers : managed {
  key ID           : String(10);
      name         : String(60);
      country      : Country;
      /** Working days between order and delivery - drives reorder points. */
      leadTimeDays : Integer;
      reliability  : Decimal(4,3);
      minOrderValue : Decimal(9,2);
}

entity ArticleGroups {
  key ID            : String(20);
      name          : String(60);
      /** The SAP export labels groups in German; kept for traceability. */
      nameDE        : String(60);
      category      : String(40);
      tempZone      : TempZone;
      /** Days of shelf life; 0 means non-perishable. */
      shelfLifeDays : Integer;
      articles      : Association to many Articles on articles.group = $self;
}

entity Articles : managed {
  key ID              : String(20);
      name            : String(80);
      group           : Association to ArticleGroups;
      supplier        : Association to Suppliers;
      unitPriceGross  : Decimal(9,4);
      unitCost        : Decimal(9,4);
      vatRatePct      : Decimal(5,2);
      currency        : Currency;
      /** Deposit ("Pfand") lines are returns of packaging, not merchandise. */
      isDeposit       : Boolean default false;
      /** Only tagged articles can be sold through the autonomous terminals. */
      isRfidTagged    : Boolean default true;
      shelfLifeDays   : Integer;
      abcClass        : AbcClass;
      /** Units the shelf holds when fully faced. */
      shelfCapacity   : Integer;
      reorderPoint    : Integer;
      /** True when the article came from the SAP Customer Checkout export. */
      isFromSapExport : Boolean default false;

      virtual grossMarginPct : Decimal(5,2);
}

entity Customers : managed {
  key ID            : String(20);
      /** S.Mart Grocery App account; entry to the store is by QR code. */
      appUserId     : String(30);
      displayName   : String(60);
      segment       : String(20);
      loyaltyTier   : String(10);
      loyaltyPoints : Integer;
      enrolledOn    : Date;
      /** Opt-in for personalised offers; gates the recommendation feed. */
      consentMarketing : Boolean default false;
      homeStore     : Association to Stores;
}

entity Employees : managed {
  key ID        : String(10);
      name      : String(60);
      role      : String(30);
      store     : Association to Stores;
      /** Matches the cashier identity recorded by SAP Customer Checkout. */
      cashierId : String(20);
}

// ---------------------------------------------------------------------------
// Sales facts
// ---------------------------------------------------------------------------

/**
 * One row per article per trading hour per store - the grain the SAP report
 * "Revenue per article and timespan" delivers, extended across the network.
 */
entity HourlySales : recordKey {
  hourStart   : Timestamp;
  businessDate : Date;
  hourOfDay   : Integer;
  dayOfWeek   : Integer;
  store       : Association to Stores;
  article     : Association to Articles;
  quantity    : Decimal(11,3);
  netRevenue  : Decimal(13,2);
  vatAmount   : Decimal(13,2);
  grossAmount : Decimal(13,2);
  currency    : Currency;
  isActual    : Boolean default true;
}

entity Receipts : recordKey {
  receiptNumber : String(24);
  store         : Association to Stores;
  posSystem     : Association to PosSystems;
  customer      : Association to Customers;
  businessDate  : Date;
  createdAt     : Timestamp;
  netRevenue    : Decimal(13,2);
  vatAmount     : Decimal(13,2);
  grossAmount   : Decimal(13,2);
  discountAmount : Decimal(13,2);
  currency      : Currency;
  paymentMethod : String(40);
  itemCount     : Integer;
  /** Seconds from store entry to payment - the autonomous-store SLA. */
  dwellSeconds  : Integer;
  items         : Composition of many ReceiptItems on items.receipt = $self;
}

entity ReceiptItems : recordKey {
  receipt      : Association to Receipts;
  article      : Association to Articles;
  quantity     : Decimal(11,3);
  unitPrice    : Decimal(9,4);
  netAmount    : Decimal(13,2);
  grossAmount  : Decimal(13,2);
  discountPct  : Decimal(5,2);
  discountType : String(30);
}

/**
 * Voided lines. On the autonomous terminals a cancellation is rarely a change
 * of mind - it is usually an RFID misread, a stray tag or an abandoned basket,
 * which is why this table drives the checkout-integrity scenario.
 */
entity Cancellations : recordKey {
  store             : Association to Stores;
  posSystem         : Association to PosSystems;
  article           : Association to Articles;
  cashier           : String(20);
  businessDate      : Date;
  cancellationCount : Integer;
  cancelledQuantity : Decimal(11,3);
  cancelledAmount   : Decimal(13,2);
  currency          : Currency;
}

entity Returns : recordKey {
  store           : Association to Stores;
  article         : Association to Articles;
  businessDate    : Date;
  returnCount     : Integer;
  returnedQuantity : Decimal(11,3);
  returnedAmount  : Decimal(13,2);
  reason          : String(40);
  currency        : Currency;
}

entity PaymentFacts : recordKey {
  store         : Association to Stores;
  posSystem     : Association to PosSystems;
  businessDate  : Date;
  paymentMethod : String(40);
  itemCount     : Integer;
  amount        : Decimal(13,2);
  currency      : Currency;
}

// ---------------------------------------------------------------------------
// Inventory and store telemetry
// ---------------------------------------------------------------------------

entity InventorySnapshots : recordKey {
  store          : Association to Stores;
  article        : Association to Articles;
  businessDate   : Date;
  /** Quantity the system believes is on the shelf. */
  bookStock      : Decimal(11,3);
  /** Quantity the RFID sweep actually found. */
  countedStock   : Decimal(11,3);
  onOrder        : Decimal(11,3);
  daysOfSupply   : Decimal(6,2);
  /** Negative means the shelf holds less than the books say - shrink. */
  virtual variance : Decimal(11,3);
}

/**
 * Readings from the shelf hardware: VusionGroup electronic labels, the ceiling
 * vision rigs that flag empty facings, and the chiller probes.
 */
entity ShelfSensorReadings : recordKey {
  store         : Association to Stores;
  article       : Association to Articles;
  readingAt     : Timestamp;
  sensorType    : String(20) enum { ESL; VISION_STOCKOUT; TEMPERATURE; WEIGHT };
  /** Fill level 0..1 for vision, degrees Celsius for temperature probes. */
  value         : Decimal(9,3);
  unit          : String(10);
  isAnomaly     : Boolean default false;
}

/** People-counting from the entrance sensors, per store per hour. */
entity FootfallReadings : recordKey {
  store        : Association to Stores;
  hourStart    : Timestamp;
  businessDate : Date;
  hourOfDay    : Integer;
  visitors     : Integer;
  /** Visitors who bought something, divided by visitors. */
  conversionRate : Decimal(5,4);
  avgDwellSeconds : Integer;
}
