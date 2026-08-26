# Backup and restore policy

The collection inventory is declared in `src/services/backupService.ts`. Source-of-truth
collections are included. `promptsearchindexes` is reproducible, while `backupruns` and
`backupleases` are operational metadata; each exclusion is recorded in every manifest.
Adding a persistent model requires updating the inventory and its coverage test.

## Consistency and memory

One MongoDB session and `readConcern: snapshot` transaction covers every collection, so
concurrent writes are either wholly before or wholly after the recovery point. MongoDB
must be a replica set or sharded cluster. Operators must configure
`transactionLifetimeLimitSeconds` above the worst-case backup RTO; the job intentionally
fails instead of falling back to an inconsistent snapshot. Cursors fetch 500 documents at
a time. gzip, SHA-256 calculation, and multipart S3 upload are one backpressured pipeline
(1 MiB local high-water mark, two 8 MiB upload parts), so memory does not grow with data size.

The signed v2 manifest contains document counts, compressed byte counts, SHA-256 checksums,
the snapshot policy, and exclusions. `latest.json` is published only after all objects and
the manifest succeed. `BACKUP_MANIFEST_SIGNING_KEY` is required; key/KMS design is unchanged.

## Scheduling and recovery objectives

`backup.crontab` is the only scheduler. A four-hour MongoDB lease prevents contention
between overlapping hosts. Daily backups target an RPO of 26 hours (`BACKUP_RPO_HOURS`).
The weekly restore drill targets 60 minutes (`BACKUP_RTO_MINUTES`), restores into a unique
temporary database, verifies signature/checksums/counts/basic references, records success,
and always drops the isolated database. Run it on demand with:

```sh
npm run backup:restore-drill
```

Alert on a non-zero cron exit and on `/health` reporting `backup.healthy: false`.
