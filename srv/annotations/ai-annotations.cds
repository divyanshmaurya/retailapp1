using { AIService } from '../ai-service';

/**
 * SAP Fiori elements annotations for the AI scenario apps.
 *
 * Fiori elements builds each list, chart and object page from the OData
 * metadata, so these annotations are the UI definition - the apps under `app/`
 * carry almost no code of their own. Keeping them here rather than in the
 * service file keeps the service readable as an API contract.
 */

// ===========================================================================
// Checkout Integrity Radar - ShrinkAlerts
// ===========================================================================

annotate AIService.ShrinkAlerts with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Integrity Alert',
      TypeNamePlural: 'Integrity Alerts',
      Title         : { Value: article.name },
      Description   : { Value: evidence },
    },

    // Criticality drives the colour of the severity column and the object
    // page header, so it is mapped once here and reused everywhere.
    SelectionFields: [ store_ID, pattern, severity, state ],

    LineItem: [
      { Value: store.name,   Label: 'Store' },
      { Value: article.name, Label: 'Article' },
      { Value: pattern,      Label: 'Pattern' },
      { Value: severity,     Label: 'Severity', Criticality: criticality },
      { Value: anomalyScore, Label: 'Score' },
      { Value: valueAtRisk,  Label: 'Value at Risk' },
      { Value: posSystem.name, Label: 'Terminal' },
      { Value: state,        Label: 'Status' },
      { Value: detectedOn,   Label: 'Detected' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.acknowledge',  Label: 'Acknowledge' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.resolveAlert', Label: 'Resolve' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.dismiss',      Label: 'Dismiss' },
    ],

    // Value at risk split by failure pattern - the first question a loss
    // prevention lead asks is "which failure mode is costing us most".
    Chart: {
      $Type: 'UI.ChartDefinitionType',
      Title: 'Value at Risk by Pattern',
      ChartType: #Donut,
      Measures: [ valueAtRisk ],
      Dimensions: [ pattern ],
      MeasureAttributes: [{
        $Type: 'UI.ChartMeasureAttributeType',
        Measure: valueAtRisk,
        Role: #Axis1,
      }],
      DimensionAttributes: [{
        $Type: 'UI.ChartDimensionAttributeType',
        Dimension: pattern,
        Role: #Category,
      }],
    },

    PresentationVariant: {
      SortOrder: [{ Property: anomalyScore, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },

    FieldGroup #Detection: {
      Data: [
        { Value: pattern,          Label: 'Failure pattern' },
        { Value: anomalyScore,     Label: 'Anomaly score' },
        { Value: cancellationRate, Label: 'Cancellation rate' },
        { Value: baselineRate,     Label: 'Network baseline' },
        { Value: valueAtRisk,      Label: 'Value at risk' },
        { Value: detectedOn,       Label: 'Detected on' },
      ],
    },
    FieldGroup #Context: {
      Data: [
        { Value: store.name,       Label: 'Store' },
        { Value: posSystem.name,   Label: 'Terminal' },
        { Value: posSystem.kind,   Label: 'Terminal type' },
        { Value: article.name,     Label: 'Article' },
        { Value: article.abcClass, Label: 'ABC class' },
        { Value: article.isRfidTagged, Label: 'RFID tagged' },
      ],
    },
    FieldGroup #Response: {
      Data: [
        { Value: evidence,          Label: 'Evidence' },
        { Value: recommendedAction, Label: 'Recommended action' },
        { Value: state,             Label: 'Status' },
      ],
    },

    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Detection', Target: '@UI.FieldGroup#Detection' },
      { $Type: 'UI.ReferenceFacet', Label: 'Context',   Target: '@UI.FieldGroup#Context' },
      { $Type: 'UI.ReferenceFacet', Label: 'Response',  Target: '@UI.FieldGroup#Response' },
    ],
  },
);

// Tabs on the list report: the open queue is what an operator works from, but
// the full history has to stay reachable for review.
annotate AIService.ShrinkAlerts with @(
  UI.SelectionVariant #Open: {
    Text: 'Open',
    SelectOptions: [{
      PropertyName: state,
      Ranges: [{ Sign: #I, Option: #EQ, Low: 'OPEN' }],
    }],
  },
  UI.SelectionVariant #All: {
    Text: 'All',
    SelectOptions: [],
  },
);

// ===========================================================================
// Replenishment Cockpit - ReplenishmentTasks
// ===========================================================================

annotate AIService.ReplenishmentTasks with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Replenishment Task',
      TypeNamePlural: 'Replenishment Tasks',
      Title         : { Value: article.name },
      Description   : { Value: reasoning },
    },
    SelectionFields: [ store_ID, urgency, state, supplier_ID ],
    LineItem: [
      { Value: store.name,      Label: 'Store' },
      { Value: article.name,    Label: 'Article' },
      { Value: onHand,          Label: 'On hand' },
      { Value: coverageHours,   Label: 'Cover (h)' },
      { Value: recommendedQty,  Label: 'Order qty' },
      { Value: urgency,         Label: 'Urgency', Criticality: criticality },
      { Value: stockoutRisk,    Label: 'Stockout risk' },
      { Value: lostSalesValue,  Label: 'Lost sales' },
      { Value: supplier.name,   Label: 'Supplier' },
      { Value: state,           Label: 'Status' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.releaseOrder', Label: 'Release Order' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.dismiss',      Label: 'Dismiss' },
    ],
    PresentationVariant: {
      SortOrder: [{ Property: lostSalesValue, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
    FieldGroup #Stock: {
      Data: [
        { Value: onHand,         Label: 'On hand' },
        { Value: reorderPoint,   Label: 'Reorder point' },
        { Value: recommendedQty, Label: 'Recommended order' },
        { Value: coverageHours,  Label: 'Coverage (hours)' },
        { Value: stockoutRisk,   Label: 'Stockout risk' },
        { Value: lostSalesValue, Label: 'Lost sales exposure' },
      ],
    },
    FieldGroup #Sourcing: {
      Data: [
        { Value: supplier.name,         Label: 'Supplier' },
        { Value: supplier.leadTimeDays, Label: 'Lead time (days)' },
        { Value: supplier.reliability,  Label: 'Reliability' },
        { Value: dueOn,                 Label: 'Due on' },
        { Value: reasoning,             Label: 'Reasoning' },
      ],
    },
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Stock position', Target: '@UI.FieldGroup#Stock' },
      { $Type: 'UI.ReferenceFacet', Label: 'Sourcing',       Target: '@UI.FieldGroup#Sourcing' },
    ],
  },
);

// ===========================================================================
// Fresh Waste Guard - MarkdownRecommendations
// ===========================================================================

annotate AIService.MarkdownRecommendations with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Markdown',
      TypeNamePlural: 'Markdown Recommendations',
      Title         : { Value: article.name },
      Description   : { Value: reasoning },
    },
    SelectionFields: [ store_ID, state, businessDate ],
    LineItem: [
      { Value: store.name,              Label: 'Store' },
      { Value: article.name,            Label: 'Article' },
      { Value: onHand,                  Label: 'On hand' },
      { Value: forecastSellThrough,     Label: 'Will sell' },
      { Value: projectedWaste,          Label: 'At risk' },
      { Value: recommendedDiscountPct,  Label: 'Markdown %', Criticality: criticality },
      { Value: expectedRecovery,        Label: 'Recovery' },
      { Value: marginImpact,            Label: 'Margin impact' },
      { Value: hoursToExpiry,           Label: 'Hours left' },
      { Value: state,                   Label: 'Status' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.applyMarkdown', Label: 'Apply Markdown' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.dismiss',       Label: 'Dismiss' },
    ],
    PresentationVariant: {
      SortOrder: [{ Property: marginImpact, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
    FieldGroup #Waste: {
      Data: [
        { Value: onHand,              Label: 'On hand' },
        { Value: forecastSellThrough, Label: 'Forecast sell-through' },
        { Value: projectedWaste,      Label: 'Projected waste' },
        { Value: hoursToExpiry,       Label: 'Hours to expiry' },
        { Value: expiresOn,           Label: 'Expires on' },
      ],
    },
    FieldGroup #Economics: {
      Data: [
        { Value: recommendedDiscountPct, Label: 'Recommended markdown' },
        { Value: expectedRecovery,       Label: 'Expected recovery' },
        { Value: wasteCostAvoided,       Label: 'Waste cost avoided' },
        { Value: marginImpact,           Label: 'Margin impact vs doing nothing' },
        { Value: reasoning,              Label: 'Reasoning' },
      ],
    },
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Waste risk', Target: '@UI.FieldGroup#Waste' },
      { $Type: 'UI.ReferenceFacet', Label: 'Economics',  Target: '@UI.FieldGroup#Economics' },
    ],
  },
);

// ===========================================================================
// Demand Forecast
// ===========================================================================

annotate AIService.DemandForecasts with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Forecast',
      TypeNamePlural: 'Demand Forecasts',
      Title         : { Value: article.name },
    },
    SelectionFields: [ store_ID, businessDate, hourOfDay ],
    LineItem: [
      { Value: store.name,    Label: 'Store' },
      { Value: article.name,  Label: 'Article' },
      { Value: forecastFor,   Label: 'Hour' },
      { Value: predictedQty,  Label: 'Forecast' },
      { Value: lowerBound,    Label: 'Low' },
      { Value: upperBound,    Label: 'High' },
      { Value: wape,          Label: 'WAPE %' },
      { Value: model,         Label: 'Model' },
    ],
    Chart: {
      $Type: 'UI.ChartDefinitionType',
      Title: 'Predicted Units by Hour',
      ChartType: #Column,
      Measures: [ predictedQty ],
      Dimensions: [ hourOfDay ],
      MeasureAttributes: [{
        $Type: 'UI.ChartMeasureAttributeType',
        Measure: predictedQty,
        Role: #Axis1,
      }],
      DimensionAttributes: [{
        $Type: 'UI.ChartDimensionAttributeType',
        Dimension: hourOfDay,
        Role: #Category,
      }],
    },
    PresentationVariant: {
      SortOrder: [{ Property: forecastFor, Descending: false }],
      Visualizations: [ '@UI.LineItem' ],
    },
  },
);

// ===========================================================================
// Basket Affinity / micro-planogram
// ===========================================================================

annotate AIService.BasketAffinities with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Affinity Rule',
      TypeNamePlural: 'Basket Affinities',
      Title         : { Value: antecedent.name },
      Description   : { Value: recommendedPlacement },
    },
    SelectionFields: [ store_ID, isCrossZone ],
    LineItem: [
      { Value: store.name,            Label: 'Store' },
      { Value: antecedent.name,       Label: 'If basket has' },
      { Value: consequent.name,       Label: 'Also buys' },
      { Value: lift,                  Label: 'Lift' },
      { Value: confidence,            Label: 'Confidence' },
      { Value: support,               Label: 'Support' },
      { Value: basketCount,           Label: 'Baskets' },
      { Value: upliftPerBasket,       Label: 'Uplift/basket' },
      { Value: isCrossZone,           Label: 'Cross zone' },
      { Value: recommendedPlacement,  Label: 'Placement' },
    ],
    PresentationVariant: {
      SortOrder: [{ Property: lift, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
  },
);

// ===========================================================================
// Personalised offers
// ===========================================================================

annotate AIService.NextBestOffers with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Offer',
      TypeNamePlural: 'Next Best Offers',
      Title         : { Value: article.name },
      Description   : { Value: rationale },
    },
    SelectionFields: [ store_ID, channel, state ],
    LineItem: [
      { Value: customer.displayName, Label: 'Customer' },
      { Value: customer.loyaltyTier, Label: 'Tier' },
      { Value: article.name,         Label: 'Offer article' },
      { Value: propensity,           Label: 'Propensity' },
      { Value: offerDiscountPct,     Label: 'Discount %' },
      { Value: expectedRevenue,      Label: 'Expected revenue' },
      { Value: channel,              Label: 'Channel' },
      { Value: state,                Label: 'Status' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.activate', Label: 'Activate' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.dismiss',  Label: 'Dismiss' },
    ],
    PresentationVariant: {
      SortOrder: [{ Property: propensity, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
  },
);

// ===========================================================================
// Cold chain
// ===========================================================================

annotate AIService.ColdChainAlerts with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Cold Chain Alert',
      TypeNamePlural: 'Cold Chain Alerts',
      Title         : { Value: assetName },
      Description   : { Value: recommendedAction },
    },
    SelectionFields: [ store_ID, severity, state ],
    LineItem: [
      { Value: store.name,     Label: 'Store' },
      { Value: assetName,      Label: 'Asset' },
      { Value: measuredTemp,   Label: 'Measured C' },
      { Value: targetTemp,     Label: 'Target C' },
      { Value: breachMinutes,  Label: 'Breach (min)' },
      { Value: severity,       Label: 'Severity', Criticality: criticality },
      { Value: stockAtRisk,    Label: 'Stock at risk' },
      { Value: state,          Label: 'Status' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.acknowledge',  Label: 'Acknowledge' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.resolveAlert', Label: 'Resolve' },
    ],
    PresentationVariant: {
      SortOrder: [{ Property: stockAtRisk, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
  },
);

// ===========================================================================
// Unified insight feed
// ===========================================================================

annotate AIService.AIInsights with @(
  UI: {
    HeaderInfo: {
      TypeName      : 'Insight',
      TypeNamePlural: 'AI Insights',
      Title         : { Value: title },
      Description   : { Value: narrative },
    },
    SelectionFields: [ store_ID, scenario, severity, state ],
    LineItem: [
      { Value: severity,          Label: 'Severity', Criticality: criticality },
      { Value: scenario,          Label: 'Scenario' },
      { Value: title,             Label: 'Insight' },
      { Value: store.name,        Label: 'Store' },
      { Value: impactValue,       Label: 'Impact' },
      { Value: confidence,        Label: 'Confidence' },
      { Value: recommendedAction, Label: 'Recommended action' },
      { Value: state,             Label: 'Status' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.acknowledge', Label: 'Acknowledge' },
      { $Type: 'UI.DataFieldForAction', Action: 'AIService.dismiss',     Label: 'Dismiss' },
    ],
    Chart: {
      $Type: 'UI.ChartDefinitionType',
      Title: 'Impact by Scenario',
      ChartType: #Bar,
      Measures: [ impactValue ],
      Dimensions: [ scenario ],
      MeasureAttributes: [{
        $Type: 'UI.ChartMeasureAttributeType',
        Measure: impactValue,
        Role: #Axis1,
      }],
      DimensionAttributes: [{
        $Type: 'UI.ChartDimensionAttributeType',
        Dimension: scenario,
        Role: #Category,
      }],
    },
    PresentationVariant: {
      SortOrder: [{ Property: impactValue, Descending: true }],
      Visualizations: [ '@UI.LineItem' ],
    },
    FieldGroup #Insight: {
      Data: [
        { Value: scenario,          Label: 'Scenario' },
        { Value: severity,          Label: 'Severity', Criticality: criticality },
        { Value: confidence,        Label: 'Model confidence' },
        { Value: impactValue,       Label: 'Value at stake' },
        { Value: detectedOn,        Label: 'Detected on' },
        { Value: narrative,         Label: 'Narrative' },
        { Value: recommendedAction, Label: 'Recommended action' },
      ],
    },
    FieldGroup #Source: {
      Data: [
        { Value: sourceEntity, Label: 'Produced by' },
        { Value: sourceId,     Label: 'Source record' },
        { Value: store.name,   Label: 'Store' },
      ],
    },
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Insight',    Target: '@UI.FieldGroup#Insight' },
      { $Type: 'UI.ReferenceFacet', Label: 'Provenance', Target: '@UI.FieldGroup#Source' },
    ],
  },
);

// ---------------------------------------------------------------------------
// Value helps
// ---------------------------------------------------------------------------

annotate AIService.ShrinkAlerts with {
  store @Common.ValueList: {
    CollectionPath: 'Stores',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: store_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
    ],
  };
};

annotate AIService.ReplenishmentTasks with {
  store @Common.ValueList: {
    CollectionPath: 'Stores',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: store_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
    ],
  };
};

annotate AIService.AIInsights with {
  store @Common.ValueList: {
    CollectionPath: 'Stores',
    Parameters: [
      { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: store_ID, ValueListProperty: 'ID' },
      { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
    ],
  };
};
