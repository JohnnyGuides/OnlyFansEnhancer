# Local thumbnail recovery and consolidation

The desktop executable supports an explicit maintenance run. It does not contact
platforms merely because a catalogue card is displayed.

```powershell
$app = "$env:LOCALAPPDATA\Programs\OFEnhancer\desktop\OFEnhancer.Desktop.exe"
Start-Process $app -WindowStyle Hidden -Wait -ArgumentList @(
  '--recover-thumbnails',
  '--thumbnail-root', '"K:\ContentCreation\.DONE_DEEDS_editfiles\.THUMBNAILS"',
  '--result', '"F:\WORK\Creations\OFEnhancer\.local\thumbnail-recovery.json"'
)
```

Without `--apply`, the command reports the current image and match counts. Add
`--apply` to recover missing covers. Optional `--consolidate-from "<folder>"`
moves images from one additional thumbnail directory into the destination after
copy verification. `--remove-resolution-variants` removes `_33` and `_4k` filename
tokens, preferring the main image if it exists and promoting the variant otherwise.
Other distinct images are retained; filename collisions receive a hash suffix.
PSD source projects are not processed.

An apply run creates a database backup and backups of all removed files beside
the result file, in `<result>.backup`. Use a new result path for each apply run.
The result records source/destination hashes, recovery counts and unresolved IDs.
File paths must remain within the explicitly supplied folders; reparse points
are rejected. Existing catalogue metadata and platform links are not edited.

Recovery tries each missing entry's saved ManyVids link, then its Pornhub Free
and Paid links. It reads `og:image` and saves a decoded PNG named by the stable
catalogue ID. Pages and image redirects are restricted to approved hosts, with
bounded response sizes and deadlines. No accounts, uploads or public posts are
modified. Deleted, unavailable or blocked pages remain unresolved; no fabricated
image is substituted. Recovered covers may be smaller than the original upload.

The scan updates the configured thumbnail root and existing bindings to the
consolidated copies. Reopen the upload form after maintenance to refresh its
in-memory thumbnail cache.
