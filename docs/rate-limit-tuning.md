# Nextcloud Rate Limit Tuning Guide

This guide covers rate limit configuration for Nextcloud deployments running MoltAgent.

## Overview

MoltAgent makes API calls to several Nextcloud endpoints:
- **Passwords API** (`/apps/passwords/`) - Credential retrieval
- **CalDAV** (`/remote.php/dav/calendars/`) - Calendar operations
- **Deck API** (`/apps/deck/`) - Task management
- **WebDAV** (`/remote.php/dav/files/`) - File operations (audit logs)
- **Talk API** (`/apps/spreed/`) - Chat messaging

The `NCRequestManager` provides request queuing, caching, and automatic backoff to minimize 429 errors. However, server-side configuration can further improve reliability.

---

## Hetzner Storage Share Configuration

Hetzner Storage Share uses Nextcloud with restricted admin access. Use `occ` commands via support ticket or SSH if available.

### Passwords App Performance Mode

Reduce rate limiting on the Passwords API:

```bash
sudo -u www-data php /var/www/nextcloud/occ config:app:set passwords performance --value=5
```

Values:
- `0` = No optimization (default, strict rate limiting)
- `1-5` = Increasing performance (relaxed rate limits)
- `5` = Maximum performance (recommended for MoltAgent)

### Verify Current Setting

```bash
sudo -u www-data php /var/www/nextcloud/occ config:app:get passwords performance
```

---

## Self-Hosted Nextcloud Configuration

### Rate Limit Override

Add to `config/config.php`:

```php
'ratelimit_overwrite' => [
    'enabled' => true,
    'time_window' => 60,      // Seconds
    'max_requests' => 100,    // Requests per window per endpoint
],
```

### Per-App Rate Limits

For granular control:

```php
'ratelimit_per_app' => [
    'passwords' => 200,    // High - credential fetches
    'deck' => 150,         // Medium - task operations
    'spreed' => 150,       // Medium - chat messages
    'dav' => 100,          // Standard - calendar/files
],
```

### Disable Rate Limiting (Not Recommended)

For testing environments only:

```php
'ratelimit.protection.enabled' => false,
```

**Warning:** This disables all rate limiting and is a security risk in production.

---

## Bruteforce Protection

Nextcloud's bruteforce protection can block MoltAgent after authentication failures.

### Symptoms

- 401 errors followed by extended blocking
- Log entries mentioning "Bruteforce" or "throttle"
- Blocking persists despite correct credentials

### Recovery

1. **Clear bruteforce attempts via occ:**
   ```bash
   sudo -u www-data php /var/www/nextcloud/occ security:bruteforce:reset <IP_ADDRESS>
   ```

2. **Clear from database:**
   ```sql
   DELETE FROM oc_bruteforce_attempts WHERE ip = 'X.X.X.X';
   ```

3. **Whitelist MoltAgent IP:**
   Add to `config/config.php`:
   ```php
   'bruteforce_protection_allowlist' => ['127.0.0.1', '10.0.0.0/8', '172.16.0.0/12'],
   ```

### Prevention

- Ensure MoltAgent credentials are correct before deployment
- NCRequestManager never retries 401/403 errors (prevents triggering bruteforce)
- Monitor credential expiration dates

---

## Monitoring NCRequestManager

### Metrics Endpoint

Access metrics programmatically:

```javascript
const metrics = ncRequestManager.getMetrics();
console.log(metrics);
// {
//   totalRequests: 1234,
//   cacheHits: 890,
//   rateLimited: 12,
//   staleServed: 5,
//   currentQueueSize: 0,
//   activeRequests: 2
// }
```

### Health Indicators

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| Cache Hit Rate | > 60% | 30-60% | < 30% |
| Rate Limited % | < 1% | 1-5% | > 5% |
| Queue Size | < 10 | 10-50 | > 50 |
| Stale Served | Occasional | Frequent | N/A |

### Log Monitoring

Watch for these patterns in MoltAgent logs:

```bash
# Rate limit events
grep "429" /var/log/moltagent/moltagent.log

# Backoff activations
grep "backoff" /var/log/moltagent/moltagent.log

# Queue growth
grep "queue size" /var/log/moltagent/moltagent.log
```

### Recommended Thresholds

Set alerts for:
- Rate limited requests > 10/hour
- Queue size sustained > 20 for > 5 minutes
- Consecutive failures > 3 for any endpoint group

---

## Expected API Call Reduction

With NCRequestManager caching:

| Scenario | Before | After | Reduction |
|----------|--------|-------|-----------|
| Heartbeat pulse | 15-20 calls | 3-5 calls | ~75% |
| Credential fetch (cached) | 1 call | 0 calls | 100% |
| Credential prefetch (batch) | 5-7 calls | 1 call | ~85% |
| Calendar check (repeat) | 1 call | 0 calls | 100% |
| Talk message send | 1 call | 1 call | 0% (writes not cached) |

**Total reduction:** 240-480 calls/hour → 60-120 calls/hour (60-75% reduction)

---

## Troubleshooting

### Still Getting 429 Errors

1. **Check cache TTLs** - May need to increase for your use case
2. **Verify prefetch** - Ensure `credentialBroker.prefetchAll()` is being called
3. **Review heartbeat interval** - Consider increasing from 5 minutes
4. **Check concurrent requests** - Default max is 4, may need adjustment

### Stale Data Issues

If seeing outdated data:

1. **Reduce cache TTL** for affected endpoint group
2. **Force cache invalidation:**
   ```javascript
   ncRequestManager.invalidateCache('/apps/deck/');
   ```
3. **Check server time sync** - Stale detection relies on timestamps

### Memory Growth

The cache has automatic cleanup but monitor:

1. **Check cache size:**
   ```javascript
   console.log('Cache entries:', ncRequestManager.cache.size);
   ```
2. **Manual cleanup:**
   ```javascript
   ncRequestManager.clearCache();
   ```

---

## Configuration Reference

### NCRequestManager Constructor Options

```javascript
const ncRequestManager = new NCRequestManager({
  nextcloud: {
    url: 'https://nc.example.com',
    username: 'moltagent'
  },
  ncResilience: {
    maxConcurrent: 4,           // Max parallel requests
    defaultBackoffMs: 30000,    // Default 429 backoff (30s)
    maxRetries: 3,              // Retry attempts before reject
    maxQueueSize: 1000,         // Queue limit
    cacheCleanupIntervalMs: 60000  // Cache cleanup frequency
  }
});
```

### Endpoint Group Defaults

| Group | Cache TTL | Priority | Pattern |
|-------|-----------|----------|---------|
| passwords | 5 min | high | `/apps/passwords/` |
| caldav | 1 min | normal | `/remote.php/dav/calendars/` |
| deck | 30 sec | normal | `/apps/deck/` |
| webdav | 30 sec | low | `/remote.php/dav/files/` |
| talk | 5 sec | normal | `/apps/spreed/` |

---

## Security Considerations

1. **Credential caching** - Credentials cached for 5 minutes. For immediate revocation, disable the NC user account.

2. **Stale data** - Stale-while-revalidate may serve outdated data during backoff. Writes are never cached.

3. **Queue persistence** - Request queue is in-memory only. Service restart drops queued requests.

4. **Authentication** - NCRequestManager uses the bootstrap credential from `CREDENTIALS_DIRECTORY`. Protect this file.
