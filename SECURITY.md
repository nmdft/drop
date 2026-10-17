# Security policy

## Reporting

Please use the repository's **Security → Report a vulnerability** feature for sensitive reports. Do not put credentials, pickup codes, revoke links, private files or exploitable details in public issues. For ordinary non-sensitive bugs, use GitHub Issues.

This is an experimental, best-effort project with no guaranteed response time. Review the current `main` branch; older copies may not receive fixes.

## Threat model and limitations

- Four-digit pickup codes have only 10,000 possibilities. They are not passwords and must not protect sensitive content.
- Content is not end-to-end encrypted. Hosting operators and the storage provider can access it. Use HTTPS, but do not confuse transport encryption with content secrecy.
- Proof of work and per-IP limits do not stop distributed guessing, bots or denial of service. Origin checks are not authentication for non-browser clients.
- Expiry stops new access; it cannot retract downloaded copies. Blob removal is asynchronous and requires a working cleanup schedule. Ready content becomes eligible for deletion at its selected pickup expiry (1 hour, 3 hours, 1 day or 3 days); the daily cleanup physically removes expired objects.
- Capacity is accounted for within this application's Blob namespace only. Deployments sharing an account must budget other projects separately.
- The Blob bakery lock depends on strong, complete reads/listing. Forced termination may leave tickets and deliberately block writes. Pause traffic and follow docs/OPERATIONS.md recovery instructions; never reset locks on an active site.
- Large files may require more than 300MB browser memory when direct file-system saving is unavailable.

## Deployment safeguards

New deployments require no manually entered secrets. A cryptographically random site signing key is initialized once in private Blob `config/site-secret-v1`, using the existing coordination lock, then reused across instances and redeploys. Existing deployments adopt their legacy SITE_SECRET once. Never delete this config during cleanup, expose it through an API, or publish Blob credentials/backups. Corrupt records and storage failures fail closed; losing the record invalidates existing user tickets.

Each build independently pairs a random schedule credential with the private task payload and server-only `lib/generated-schedule.js`. This generated file is ignored by Git and never copied to public assets. Restrict build/configuration access. Schedule credentials may change on deployment without rotating the persisted site key. The public scheduled endpoint validates the credential before storage access. Never trust an unverified caller merely because the platform also uses that URL.

Keep `.env`, `.edgeone/`, generated private configuration, access tokens and user content out of source archives. Ordinary tests must not use production credentials. Each fork needs its own hosting project, Blob storage, native schedule verification, traffic limits and spending alerts.

Never run real-storage or cleanup tools against another operator's service. The diagnostic scripts can create/delete data and the lock reset script requires maintenance downtime.
