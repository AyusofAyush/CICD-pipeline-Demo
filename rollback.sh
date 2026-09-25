#!/usr/bin/env bash
#
# Instant rollback: shift 100% of Cloud Run traffic to an existing revision.
# No rebuild, no redeploy - the old container image is already there.
#
# Usage:
#   ./rollback.sh                    # list revisions, then prompt
#   ./rollback.sh demo-project-00002-abc  # roll straight back to that revision
#
set -euo pipefail

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-south1}"
SERVICE_NAME="${SERVICE_NAME:-demo-project}"
TARGET_REVISION="${1:-}"

# ./rollback.sh --to-previous  = jump straight back to the last revision that
# held traffic before the current one. No prompt, no revision name to type.
if [[ "${TARGET_REVISION}" == "--to-previous" ]]; then
  TARGET_REVISION="$(gcloud run revisions list \
      --service "${SERVICE_NAME}" --region "${REGION}" --project "${PROJECT_ID}" \
      --sort-by="~metadata.creationTimestamp" --format='value(metadata.name)' \
    | sed -n '2p')"
  if [[ -z "${TARGET_REVISION}" ]]; then
    echo "No previous revision exists yet - nothing to roll back to." >&2
    exit 1
  fi
  echo "Previous revision resolved to: ${TARGET_REVISION}"
fi

echo "Revisions for '${SERVICE_NAME}' in ${REGION} (newest first):"
echo
gcloud run revisions list \
  --service "${SERVICE_NAME}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --sort-by="~metadata.creationTimestamp" \
  --format="table[box](
      metadata.name:label=REVISION,
      status.conditions[0].status:label=READY,
      metadata.labels.commit-sha:label=COMMIT,
      spec.containers[0].image.basename():label=IMAGE_TAG,
      metadata.creationTimestamp.date('%Y-%m-%d %H:%M'):label=CREATED)"
echo
echo "Current traffic split:"
gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" --project "${PROJECT_ID}" \
  --format="table[box](status.traffic[].revisionName:label=REVISION,
                       status.traffic[].percent:label=PERCENT)"
echo

if [[ -z "${TARGET_REVISION}" ]]; then
  read -r -p "Roll 100% of traffic to which revision? " TARGET_REVISION
fi
[[ -n "${TARGET_REVISION}" ]] || { echo "No revision given. Aborted."; exit 1; }

echo
echo "Running:"
echo "  gcloud run services update-traffic ${SERVICE_NAME} \\"
echo "    --region ${REGION} \\"
echo "    --to-revisions ${TARGET_REVISION}=100"
echo
read -r -p "Proceed? [y/N] " reply
[[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 1; }

gcloud run services update-traffic "${SERVICE_NAME}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --to-revisions "${TARGET_REVISION}=100"

URL="$(gcloud run services describe "${SERVICE_NAME}" \
        --region "${REGION}" --project "${PROJECT_ID}" \
        --format='value(status.url)')"

echo
echo "Traffic now on ${TARGET_REVISION}. Verifying live service:"
printf '  /health   -> HTTP %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "${URL}/health")"
echo "  /api/info ->"
curl -s "${URL}/api/info" | sed 's/^/    /'
echo
echo "Traffic split now:"
gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" --project "${PROJECT_ID}" \
  --format="table[box](status.traffic[].revisionName:label=REVISION,
                       status.traffic[].percent:label=PERCENT)"
