sap.ui.define(['sap/fe/core/AppComponent'], function (AppComponent) {
  'use strict';

  // SAP Fiori elements builds the whole app from the manifest and the OData
  // annotations, so this component only has to declare itself.
  return AppComponent.extend('smart.retail.basketaffinity.Component', {
    metadata: { manifest: 'json' },
  });
});
