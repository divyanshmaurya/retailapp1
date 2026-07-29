# Deploying to SAP HANA Cloud

The project runs on SQLite locally and on SAP HANA Cloud in production. Nothing in the CDS model,
the services or the engines changes between the two — only the `db` binding in `package.json`,
which switches to `hana` under the `[production]` profile.

## Prerequisites

- An SAP BTP subaccount with **Cloud Foundry** enabled and an **SAP HANA Cloud** instance running
- The Cloud Foundry CLI (`cf`) with the MultiApps plugin:
  `cf install-plugin multiapps`
- The Cloud MTA Build Tool: `npm install -g mbt`
- `@sap/cds-dk` (already a dev dependency here)

## 1. Generate the HANA artifacts

```bash
npm run build          # cds build --production
```

This writes:

| Path | Contents |
|---|---|
| `gen/db/src/gen/*.hdbtable` | 30 HANA column tables for the `smart.retail` namespace |
| `gen/db/src/gen/*.hdbview` | Views backing the service projections and aggregates |
| `gen/db/src/gen/data/*.csv` | The seed dataset |
| `gen/db/src/gen/data/*.hdbtabledata` | Loader descriptors that import those CSVs at deploy time |
| `gen/srv/` | The CAP service, packaged for the Node.js buildpack |

Check what was produced before deploying:

```bash
ls gen/db/src/gen/*.hdbtable | wc -l      # expect 30
ls gen/db/src/gen/data/*.csv | wc -l      # expect 25
```

## 2. Deploy the database on its own (fastest path)

Useful when you only want the schema and data in HANA and intend to run the service locally
against it.

```bash
cf create-service hana hdi-shared smartstore-db
npm run deploy:hana        # cds deploy --to hana:smartstore-db --store-credentials
```

`--store-credentials` writes the binding into `~/.cds-services.json`, so `cds watch --profile
hybrid` afterwards runs the local service against the HANA container.

Verify:

```sql
SELECT COUNT(*) FROM SMART_RETAIL_HOURLYSALES;   -- 27,118
SELECT COUNT(*) FROM SMART_RETAIL_AIINSIGHTS;    -- ~107
SELECT COUNT(*) FROM SMART_RETAIL_ARTICLES;      -- 327
```

## 3. Deploy the whole application

```bash
mbt build                                  # produces mta_archives/smartstore-retail-ai_1.0.0.mtar
cf deploy mta_archives/smartstore-retail-ai_1.0.0.mtar
```

`mta.yaml` deploys five things:

| Module / resource | Role |
|---|---|
| `smartstore-srv` | The CAP OData V4 services and the scenario engines |
| `smartstore-db-deployer` | HDI deployer — creates the tables and loads the seed data |
| `smartstore-app` | Static UI: launchpad, command centre, Fiori elements apps |
| `smartstore-db` | HDI container on SAP HANA Cloud |
| `smartstore-auth` | XSUAA instance, configured from `xs-security.json` |

## 4. Assign roles

`xs-security.json` defines three role collections. Assign them in the BTP cockpit under
**Security → Role Collections**:

| Role collection | Grants |
|---|---|
| `SMartRetailViewer` | Read dashboards and scenario output |
| `SMartRetailAnalyst` | The above, plus re-running the scenario engines |
| `SMartRetailStoreManager` | The above, plus working the alert and task queues |

The `store` attribute on each role template is there to restrict a user to the stores they are
responsible for; wire it to an identity-provider attribute if you need that.

## Re-running the engines against HANA

Once deployed, the engines run server-side against HANA rather than against the CSVs:

```bash
curl -u <user>:<pass> -X POST https://<srv-url>/ai/recalculate \
  -H 'Content-Type: application/json' -d '{}'
```

Every scenario is replaced and the unified insight feed is rebuilt. Pass `{"scenario":"..."}` to
refresh one, or `{"store_ID":"WDF01"}` to scope the run to a single store.

## Notes and gotchas

- **Decimal precision.** The model uses explicit `Decimal(p,s)` throughout rather than `Double`,
  so money arithmetic behaves the same on HANA as it does on SQLite.
- **Keys are strings, not UUIDs.** The fact and AI tables use readable keys (`SA-000042`) so the
  regenerated dataset stays diffable and `AIInsights.sourceId` can point at a scenario row. If you
  prefer UUIDs, swap the `recordKey` aspect in `db/common.cds` for `cuid` — but the engines emit
  the readable form, so they would need to change too.
- **Seed data is replaced, not merged.** `.hdbtabledata` performs a full load. If you have edited
  rows in HANA that you want to keep, delete the corresponding CSVs from `gen/db/src/gen/data/`
  before deploying.
- **The `app` module needs no build step.** The command centre is a single self-contained HTML
  file, and the Fiori elements apps are manifest-driven, so there is no UI5 tooling build in the
  pipeline. If you later add one, put it in `build-parameters` for `smartstore-app`.
- **Air-gapped landscapes.** The Fiori elements apps bootstrap SAPUI5 from `https://ui5.sap.com`.
  Where that host is unreachable, either point the bootstrap at a local UI5 distribution or use the
  AI Command Centre, which carries no external dependency.
