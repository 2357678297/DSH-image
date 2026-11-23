# Deprecated bulk-publish entry. Never stage, commit, tag or push from here.
[Console]::Error.WriteLine('Bulk publishing is disabled. Open the local release editor: npm run release:editor')
[Console]::Error.WriteLine('Read-only status: npm run release:status. No files or remote refs were changed.')
exit 2
