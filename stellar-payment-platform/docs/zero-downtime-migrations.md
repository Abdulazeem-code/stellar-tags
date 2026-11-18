# Zero-Downtime Database Schema Migrations Runbook

This runbook documents the **Expand and Contract** methodology for performing zero-downtime schema migrations in the Stellar Payment Platform. 

## Problem: The Table Lock Issue
Standard migrations (like renaming a column, or adding a new column with a default value to a large table) can lock the table for the duration of the migration. For large tables (e.g., `Payment`, `User`), this causes application downtime and request timeouts.

## Solution: Expand and Contract Pattern
The expand and contract pattern ensures backward compatibility with the currently running application code, allowing the database to be migrated safely before or after the application code is deployed, without locking large tables.

The process is divided into multiple phases (deployments):

### Phase 1: Expand (Add the New Schema)
In this phase, we add the new schema elements without removing the old ones.
1. **Schema Update**: Add the new column or table to `schema.prisma`. 
   - *Crucial*: The new column must be **nullable** or have a non-locking default value. Do not drop or rename the old column yet.
2. **Generate Migration**: Run `npx prisma migrate dev --name expand_my_column` to generate the SQL migration.
3. **Application Update (Dual Write)**: Update the application code to write to **both** the old and the new columns, but continue reading from the old column.
4. **Deploy**: Deploy the database migration and the updated application code.

### Phase 2: Backfill Data
If the table has existing data, we must backfill the new column with data from the old column.
1. **Script**: Create a background script or use a Prisma migration script to copy data in batches to avoid locking the table.
2. **Execute**: Run the backfill script until both columns are synchronized for all rows.

### Phase 3: Transition (Read from New Schema)
Now that the data is synchronized and new writes populate both columns, we switch the application to read from the new column.
1. **Application Update**: Update the application code to **read exclusively** from the new column. It can stop writing to the old column at this point (or continue if a rollback strategy is needed).
2. **Deploy**: Deploy the updated application code.

### Phase 4: Contract (Clean Up Old Schema)
Once the new column is fully utilized and the old column is no longer needed by any running instance of the application, we can safely remove it.
1. **Schema Update**: Remove the old column from `schema.prisma`.
2. **Generate Migration**: Run `npx prisma migrate dev --name contract_drop_old_column` to generate the SQL migration to drop the column.
3. **Application Update**: Remove any remaining code referencing the old column.
4. **Deploy**: Deploy the final migration and code cleanup.

## Example: Renaming a Column
If you need to rename `fromAddress` to `senderAddress` in the `Payment` table:
1. **Expand**: Add `senderAddress` (nullable) to the model. Deploy.
2. **Backfill**: Update existing `Payment` records to set `senderAddress` = `fromAddress` in batches.
3. **Transition**: Update application to read/write `senderAddress`.
4. **Contract**: Drop `fromAddress` from the model. Deploy.

By following this pattern, we ensure that zero downtime occurs during schema updates.
