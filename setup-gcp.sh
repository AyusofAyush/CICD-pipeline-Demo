#!/usr/bin/env bash
#
# One-shot provisioning for the Cloud Build -> Artifact Registry -> Cloud Run demo.
# Safe to re-run: every step is idempotent.
#
# Usage:  cp .env.example .env && edit .env && ./setup-gcp.sh
#
set -euo pipefail

# ---------------------------------------------------------------- config ----
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-south1}"
AR_REPO="${AR_REPO:-demo-project}"
SERVICE_NAME="${SERVICE_NAME:-demo-project}"
GITHUB_OWNER="${GITHUB_OWNER:-}"
GITHUB_REPO="${GITHUB_REPO:-}"

BUILD_SA="demo-project-build"
RUNTIME_SA="demo-project-run"
BUILD_SA_EMAIL="${BUILD_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

for var in PROJECT_ID GITHUB_OWNER GITHUB_REPO; do
  if [[ -z "${!var}" ]]; then
    echo "ERROR: $var is not set. Copy .env.example to .env and fill it in." >&2
    exit 1
  fi
done

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }

bold "About to provision in project: ${PROJECT_ID}"
cat <<EOF
  Region                : ${REGION}
  Artifact Registry repo: ${AR_REPO}
  Cloud Run service     : ${SERVICE_NAME}
  Cloud Build SA        : ${BUILD_SA_EMAIL}
  Cloud Run runtime SA  : ${RUNTIME_SA_EMAIL}
  GitHub repo           : ${GITHUB_OWNER}/${GITHUB_REPO}
EOF
read -r -p "Proceed? [y/N] " reply
[[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 1; }

gcloud config set project "${PROJECT_ID}" >/dev/null

# ------------------------------------------------------------------ APIs ----
bold "[1/5] Enabling APIs (cloudbuild, run, artifactregistry, iam)"
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  --project "${PROJECT_ID}"

# ------------------------------------------------- Artifact Registry repo ----
bold "[2/5] Creating Artifact Registry repo '${AR_REPO}' (${REGION})"
if gcloud artifacts repositories describe "${AR_REPO}" \
     --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  already exists - skipping"
else
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Images for the ${SERVICE_NAME} CI/CD demo" \
    --project "${PROJECT_ID}"
fi

# ------------------------------------------------------- service accounts ----
bold "[3/5] Creating service accounts and granting least-privilege IAM"

create_sa() {
  local name="$1" display="$2"
  if gcloud iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com" \
       --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "  SA ${name} already exists - skipping"
  else
    gcloud iam service-accounts create "${name}" \
      --display-name="${display}" --project "${PROJECT_ID}"
  fi
}

create_sa "${RUNTIME_SA}" "Cloud Run runtime SA (${SERVICE_NAME})"
create_sa "${BUILD_SA}"   "Cloud Build CI/CD SA (${SERVICE_NAME})"

# Project-level roles for the build SA - exactly what the pipeline needs.
#   artifactregistry.writer : push images
#   run.admin               : create revisions + set traffic + allow-unauthenticated
#   logging.logWriter       : required for builds that run as a custom SA
for role in roles/artifactregistry.writer roles/run.admin roles/logging.logWriter; do
  echo "  granting ${role} to ${BUILD_SA_EMAIL}"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${BUILD_SA_EMAIL}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
done

# Scoped to the runtime SA only - lets Cloud Build deploy Cloud Run AS that SA.
echo "  granting roles/iam.serviceAccountUser on ${RUNTIME_SA_EMAIL}"
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_SA_EMAIL}" \
  --member="serviceAccount:${BUILD_SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" \
  --project "${PROJECT_ID}" \
  --quiet >/dev/null

# ------------------------------------------------- manual GitHub App step ----
bold "[4/5] MANUAL STEP - connect GitHub to Cloud Build"
cat <<EOF
gcloud cannot install the Cloud Build GitHub App for you. Do this now:

  1. Open: https://console.cloud.google.com/cloud-build/triggers?project=${PROJECT_ID}
  2. Set the region selector to: global   (1st-gen GitHub App connections are global)
  3. Click  CONNECT REPOSITORY
  4. Source: "GitHub (Cloud Build GitHub App)"  -> Continue
  5. Authenticate, then install/authorize the app on: ${GITHUB_OWNER}/${GITHUB_REPO}
  6. Tick the repository checkbox, accept the terms, click CONNECT
  7. On the next screen click DONE / SKIP FOR NOW - this script creates the triggers.

EOF
read -r -p "Repository connected? [y/N] " reply
[[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted before trigger creation."; exit 1; }

# ---------------------------------------------------------------- triggers ----
bold "[5/5] Creating Cloud Build triggers"

# The 1st-gen GitHub App stores its repo mapping in 'global', not in a region.
# Creating a trigger in ${REGION} against that mapping fails with
# "FAILED_PRECONDITION: Repository mapping does not exist".
# The build still deploys to Cloud Run in ${REGION}; only the trigger is global.
TRIGGER_REGION="${TRIGGER_REGION:-global}"

SUBS="_REGION=${REGION},_AR_REPO=${AR_REPO},_SERVICE_NAME=${SERVICE_NAME},_RUNTIME_SA=${RUNTIME_SA_EMAIL},_BREAK_HEALTH=false"

# Trigger 1: pull requests to main -> tests only, reported as a PR status check.
if gcloud builds triggers describe "${SERVICE_NAME}-pr" --region="${TRIGGER_REGION}" \
     --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  trigger ${SERVICE_NAME}-pr already exists - skipping"
else
  gcloud builds triggers create github \
    --name="${SERVICE_NAME}-pr" \
    --region="${TRIGGER_REGION}" \
    --repo-owner="${GITHUB_OWNER}" \
    --repo-name="${GITHUB_REPO}" \
    --pull-request-pattern='.*' \
    --comment-control=COMMENTS_DISABLED \
    --build-config="cloudbuild-pr.yaml" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA_EMAIL}" \
    --description="PR (any base branch): lint + test only" \
    --project "${PROJECT_ID}"
fi

# Trigger 2: push to main -> test, build, push, deploy.
if gcloud builds triggers describe "${SERVICE_NAME}-main" --region="${TRIGGER_REGION}" \
     --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  trigger ${SERVICE_NAME}-main already exists - skipping"
else
  gcloud builds triggers create github \
    --name="${SERVICE_NAME}-main" \
    --region="${TRIGGER_REGION}" \
    --repo-owner="${GITHUB_OWNER}" \
    --repo-name="${GITHUB_REPO}" \
    --branch-pattern='^(main|master)$' \
    --build-config="cloudbuild.yaml" \
    --substitutions="${SUBS}" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA_EMAIL}" \
    --description="Push to main/master: test, build, push, deploy to Cloud Run" \
    --project "${PROJECT_ID}"
fi

bold "Done."
cat <<EOF
Next: push a commit to main, then watch
  https://console.cloud.google.com/cloud-build/builds?project=${PROJECT_ID}

After the first successful deploy, get the URL with:
  gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format='value(status.url)'
EOF
