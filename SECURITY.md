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

Generate independent random `SITE_SECRET` and `CLEANUP_SECRET` values (at least 32 characters each). Keep `.env`, `.edgeone/`, access tokens and user content out of source archives. Ordinary tests must not use production credentials. A fork needs its own hosting project, secrets, `SITE_URL`, cleanup verification, traffic limits and spending alerts.

Never run real-storage or cleanup tools against another operator's service. The diagnostic scripts can create/delete data and the lock reset script requires maintenance downtime.
