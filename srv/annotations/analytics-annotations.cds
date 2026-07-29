using { AnalyticsService } from '../analytics-service';

/**
 * SAP Fiori elements annotations for the analytical surface. These entities are
 * read-only aggregates, so they carry list and chart definitions but no actions.
 */

// ---------------------------------------------------------------------------
// Store master
// ---------------------------------------------------------------------------

annotate AnalyticsService.Stores with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Store',
      TypeNamePlural: 'Stores',
      Title         : { Value: name },
      Description   : { Value: city },
    },
    SelectionFields: [ format, city ],
    LineItem: [
      { Value: ID,               Label: 'Store' },
      { Value: name,             Label: 'Name' },
      { Value: format,           Label: 'Format' },
      { Value: city,             Label: 'City' },
      { Value: salesArea,        Label: 'Sales area (m2)' },
      { Value: opensAt,          Label: 'Opens' },
      { Value: closesAt,         Label: 'Closes' },
      { Value: catchmentSize,    Label: 'Catchment' },
      { Value: isReferenceStore, Label: 'From SAP export' },
    ],
    FieldGroup #Profile: {
      Data: [
        { Value: format,           Label: 'Format' },
        { Value: city,             Label: 'City' },
        { Value: salesArea,        Label: 'Sales area (m2)' },
        { Value: catchmentSize,    Label: 'Catchment population' },
        { Value: opensAt,          Label: 'Opens at' },
        { Value: closesAt,         Label: 'Closes at' },
        { Value: isReferenceStore, Label: 'Figures from the SAP export' },
      ],
    },
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Profile', Target: '@UI.FieldGroup#Profile' },
    ],
  },
);

// ---------------------------------------------------------------------------
// Article performance
// ---------------------------------------------------------------------------

annotate AnalyticsService.ArticlePerformance with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Article',
      TypeNamePlural: 'Article Performance',
      Title         : { Value: articleName },
      Description   : { Value: groupName },
    },
    SelectionFields: [ storeId, category, abcClass, tempZone ],
    LineItem: [
      { Value: articleName, Label: 'Article' },
      { Value: storeName,   Label: 'Store' },
      { Value: groupName,   Label: 'Group' },
      { Value: category,    Label: 'Category' },
      { Value: abcClass,    Label: 'ABC' },
      { Value: unitsSold,   Label: 'Units' },
      { Value: netRevenue,  Label: 'Net revenue' },
      { Value: grossAmount, Label: 'Gross' },
    ],
    Chart: {
      $Type: 'UI.ChartDefinitionType',
      Title: 'Gross Sales by Category',
      ChartType: #Bar,
      Measures: [ grossAmount ],
      Dimensions: [ category ],
      MeasureAttributes: [{
        $Type: 'UI.ChartMeasureAttributeType',
        Measure: grossAmount,
        Role: #Axis1,
      }],
      DimensionAttributes: [{
        $Type: 'UI.ChartDimensionAttributeType',
        Dimension: category,
        Role: #Category,
      }],
    },
    PresentationVariant: {
      SortOrder: [{ Property: grossAmount, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
  },
);

// ---------------------------------------------------------------------------
// Daily sales
// ---------------------------------------------------------------------------

annotate AnalyticsService.DailySales with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Trading Day',
      TypeNamePlural: 'Daily Sales',
      Title         : { Value: storeName },
      Description   : { Value: businessDate },
    },
    SelectionFields: [ storeId, businessDate ],
    LineItem: [
      { Value: businessDate, Label: 'Date' },
      { Value: storeName,    Label: 'Store' },
      { Value: storeFormat,  Label: 'Format' },
      { Value: quantity,     Label: 'Units' },
      { Value: netRevenue,   Label: 'Net revenue' },
      { Value: vatAmount,    Label: 'VAT' },
      { Value: grossAmount,  Label: 'Gross' },
    ],
    Chart: {
      $Type: 'UI.ChartDefinitionType',
      Title: 'Gross Sales by Day',
      ChartType: #Line,
      Measures: [ grossAmount ],
      Dimensions: [ businessDate ],
      MeasureAttributes: [{
        $Type: 'UI.ChartMeasureAttributeType',
        Measure: grossAmount,
        Role: #Axis1,
      }],
      DimensionAttributes: [{
        $Type: 'UI.ChartDimensionAttributeType',
        Dimension: businessDate,
        Role: #Category,
      }],
    },
    PresentationVariant: {
      SortOrder: [{ Property: businessDate, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
  },
);

// ---------------------------------------------------------------------------
// Channel mix
// ---------------------------------------------------------------------------

annotate AnalyticsService.ChannelMix with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Channel',
      TypeNamePlural: 'Channel Mix',
      Title         : { Value: posSystemName },
      Description   : { Value: storeName },
    },
    SelectionFields: [ storeId, posKind ],
    LineItem: [
      { Value: storeName,       Label: 'Store' },
      { Value: posSystemName,   Label: 'Terminal' },
      { Value: posKind,         Label: 'Type' },
      { Value: receiptCount,    Label: 'Receipts' },
      { Value: grossAmount,     Label: 'Gross' },
      { Value: avgBasketSize,   Label: 'Avg basket' },
      { Value: avgDwellSeconds, Label: 'Avg trip (s)' },
    ],
    Chart: {
      $Type: 'UI.ChartDefinitionType',
      Title: 'Receipts by Terminal Type',
      ChartType: #Donut,
      Measures: [ receiptCount ],
      Dimensions: [ posKind ],
      MeasureAttributes: [{
        $Type: 'UI.ChartMeasureAttributeType',
        Measure: receiptCount,
        Role: #Axis1,
      }],
      DimensionAttributes: [{
        $Type: 'UI.ChartDimensionAttributeType',
        Dimension: posKind,
        Role: #Category,
      }],
    },
    PresentationVariant: {
      SortOrder: [{ Property: receiptCount, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
  },
);

// ---------------------------------------------------------------------------
// Hourly pattern
// ---------------------------------------------------------------------------

annotate AnalyticsService.SalesByHour with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Trading Hour',
      TypeNamePlural: 'Sales by Hour',
      Title         : { Value: storeName },
    },
    SelectionFields: [ storeId, dayOfWeek ],
    LineItem: [
      { Value: storeName,   Label: 'Store' },
      { Value: dayOfWeek,   Label: 'Day of week' },
      { Value: hourOfDay,   Label: 'Hour' },
      { Value: quantity,    Label: 'Units' },
      { Value: grossAmount, Label: 'Gross' },
      { Value: dataPoints,  Label: 'Observations' },
    ],
    Chart: {
      $Type: 'UI.ChartDefinitionType',
      Title: 'Units by Hour of Day',
      ChartType: #Column,
      Measures: [ quantity ],
      Dimensions: [ hourOfDay ],
      MeasureAttributes: [{
        $Type: 'UI.ChartMeasureAttributeType',
        Measure: quantity,
        Role: #Axis1,
      }],
      DimensionAttributes: [{
        $Type: 'UI.ChartDimensionAttributeType',
        Dimension: hourOfDay,
        Role: #Category,
      }],
    },
    PresentationVariant: {
      SortOrder: [{ Property: hourOfDay, Descending: false }],
      Visualizations: [ '@UI.LineItem' ],
    },
  },
);
