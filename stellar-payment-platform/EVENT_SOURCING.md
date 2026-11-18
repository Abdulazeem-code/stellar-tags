# Event Sourcing Architecture for Payment Ledger

## Overview

This implementation introduces an **Event Sourcing** architecture for the payment ledger, providing complete audit trails and the ability to reconstruct payment state from immutable event streams.

## Architecture

### Core Components

1. **Event Store** (`src/services/eventStore.js`)
   - Append-only immutable event log
   - Handles event persistence with optimistic concurrency control
   - Provides event replay and state reconstruction

2. **Command Service** (`src/services/paymentCommandService.js`)
   - Write-side (commands) of CQRS pattern
   - Handles payment state transitions by appending events
   - Validates business rules before event creation

3. **Query Service** (`src/services/paymentQueryService.js`)
   - Read-side (queries) of CQRS pattern
   - Reads from denormalized read models
   - Provides fast query performance

4. **Read Model Updater** (`src/services/readModelUpdater.js`)
   - Asynchronously processes events
   - Updates read models for query optimization
   - Implements eventual consistency

5. **Event Processor Worker** (`event-processor-worker.js`)
   - Background process for continuous event processing
   - Polls for new events and updates read models
   - Maintains processing checkpoints

## Event Types

```javascript
PAYMENT_CREATED         // Payment initiated
PAYMENT_VALIDATED       // Payment validation passed
PAYMENT_ROUTED          // Payment routed to Stellar network
PAYMENT_COMPLETED       // Payment successfully completed
PAYMENT_FAILED          // Payment failed
PAYMENT_REFUNDED        // Payment refunded
PAYMENT_FLAGGED_FRAUD   // Payment flagged for fraud
PAYMENT_CLEARED_FRAUD   // Fraud flag cleared
```

## Database Schema

### payment_events
Immutable append-only event log:
- `id` - Unique event identifier
- `payment_id` - Payment identifier
- `event_type` - Type of event
- `aggregate_id` - Aggregate root ID (same as payment_id)
- `sequence` - Sequential order within aggregate
- `timestamp` - Event timestamp
- `event_data` - Full event payload (JSON)
- `metadata` - Additional context (JSON)

### payment_read_models
Denormalized view derived from events:
- `id` - Payment ID (aggregate ID)
- `current_state` - Current payment status
- `from_address`, `to_address`, `amount`, etc.
- `last_event_seq` - Last processed event sequence
- `version` - Optimistic locking version

### event_checkpoints
Tracks consumer progress:
- `consumer_name` - Name of event consumer
- `last_event_id` - Last processed event
- `last_sequence` - Last processed sequence number
- `last_timestamp` - Timestamp of last event

## API Endpoints

### Commands (Write Operations)

```
POST   /api/v1/event-sourced-payments              Create payment
POST   /api/v1/event-sourced-payments/:id/route    Route payment
POST   /api/v1/event-sourced-payments/:id/complete Complete payment
POST   /api/v1/event-sourced-payments/:id/fail     Fail payment
POST   /api/v1/event-sourced-payments/:id/flag-fraud     Flag for fraud
POST   /api/v1/event-sourced-payments/:id/clear-fraud    Clear fraud flag
```

### Queries (Read Operations)

```
GET    /api/v1/event-sourced-payments              List payments
GET    /api/v1/event-sourced-payments/:id          Get payment
GET    /api/v1/event-sourced-payments/:id/history  Get payment with event history
GET    /api/v1/event-sourced-payments/stats        Get statistics
GET    /api/v1/event-sourced-payments/:id/verify   Verify consistency
```

### Admin Operations

```
POST   /api/v1/event-sourced-payments/admin/process-events        Process pending events
POST   /api/v1/event-sourced-payments/admin/rebuild-read-models   Rebuild all read models
```

## Usage Examples

### Creating a Payment

```javascript
const response = await fetch('/api/v1/event-sourced-payments', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    fromAddress: 'GABC...',
    toAddress: 'GXYZ...',
    amount: 100.50,
    fee: 0.00001,
    assetCode: 'XLM'
  })
});

// Response: { paymentId, eventId, status: 'created' }
```

### Getting Payment History

```javascript
const response = await fetch('/api/v1/event-sourced-payments/abc-123/history');

// Response includes:
// - payment: Current state from read model
// - events: Array of all events in order
// - eventCount: Total number of events
```

### Routing a Payment

```javascript
await fetch('/api/v1/event-sourced-payments/abc-123/route', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    transactionHash: '0xabc...'
  })
});
```

## Running the Event Processor

The event processor should run as a separate background process:

```bash
npm run event-processor
```

Or in production with PM2:

```bash
pm2 start event-processor-worker.js --name event-processor
```

### Environment Configuration

```env
EVENT_PROCESSOR_INTERVAL=5000  # Polling interval in milliseconds (default: 5000)
```

## Benefits

1. **Complete Audit Trail**
   - Every state change is recorded as an immutable event
   - Full history of what happened, when, and by whom

2. **Time Travel**
   - Reconstruct payment state at any point in time
   - Debug issues by replaying events

3. **Event Replay**
   - Rebuild read models from scratch
   - Recover from data corruption

4. **Scalability**
   - Read and write sides can scale independently
   - Multiple read models for different use cases

5. **Debugging**
   - Events provide complete context for troubleshooting
   - Can verify consistency between events and read models

## Consistency Model

- **Write Model**: Strong consistency (immediate)
- **Read Model**: Eventual consistency (typically < 5 seconds)

For strong consistency reads, use the `/history` endpoint which reads directly from events.

## Optimistic Concurrency

The system uses optimistic locking to handle concurrent updates:
- Events have unique `(aggregate_id, sequence)` constraint
- Read models have version numbers
- Concurrent modifications are detected and handled gracefully

## Monitoring

Key metrics to monitor:
- Event processing lag (events pending processing)
- Read model update latency
- Event store size growth
- Query performance on read models

## Migration from Legacy System

To migrate existing payments to event sourcing:

1. Create `PAYMENT_CREATED` events for existing payments
2. Run `POST /admin/rebuild-read-models` to build read models
3. Gradually transition new payments to use event-sourced endpoints

## Best Practices

1. **Events are immutable** - Never modify or delete events
2. **Events are facts** - Name events in past tense (e.g., PAYMENT_CREATED)
3. **Keep events small** - Store only essential data
4. **Version events** - Use `event_version` for schema evolution
5. **Idempotency** - Handle duplicate events gracefully

## Troubleshooting

### Read model out of sync

```bash
# Manually trigger event processing
curl -X POST /api/v1/event-sourced-payments/admin/process-events

# Or rebuild from scratch
curl -X POST /api/v1/event-sourced-payments/admin/rebuild-read-models
```

### Verify payment consistency

```bash
curl /api/v1/event-sourced-payments/{paymentId}/verify
```

This compares the current read model with state rebuilt from events.

## Future Enhancements

- Event versioning and upcasting
- Snapshotting for performance
- Event replay with filters
- Multiple read models (analytics, reporting, etc.)
- Event streaming for command-side events (payment status updates already
  stream to clients via SSE, see #730)
- Integration with external event buses (Kafka, RabbitMQ)
