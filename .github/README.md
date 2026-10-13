# Registry publication

Each push runs Quality once. `publish_action.yml` follows the existing
successful Quality run on `master` (Image) or `main` (Video), using GitHub's
[`workflow_run` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
It checks out the exact commit that passed Quality, reads the name and version
from `pyproject.toml`, and uploads only if that version's archive is missing.
There is no second Quality run inside Publish. Pull request and fork runs cannot
publish.

If quality or publishing fails, the next push retries the same unpublished
version; no extra version bump or manual dispatch is needed. After the archive
exists, subsequent successful Quality runs skip the upload.
Quality still checks every push and pull request.
Registry review may remain Pending or Flagged after an upload; uploading the
same version again does not resolve review status.

Only a 404 means a version/archive is missing. Network, permission, and server
errors fail the check and can be retried on the next push. The public registry
is the durable publication record, so existing releases also skip correctly.
The check uses the registry's [exact-version API](https://github.com/Comfy-Org/registry-backend/blob/main/openapi.yml).

Publish runs are serialized without cancelling an active upload. GitHub may
replace an older pending run with the newest push while another run is active.
For a manual release, run Quality on the release branch; its success triggers
Publish. To retry a failed upload without retesting the same commit, rerun that
Publish run. Both paths use the same lock and version check.

The small embedded check is kept in both repository workflows so each release
can check its version without loading a companion checkout. Keep these checks in
sync. `tests/test_registry_publish.py` exercises Image's actual embedded script
and also Video's when `STUDIO_TEST_VIDEO=1` (as in Video integration CI).
