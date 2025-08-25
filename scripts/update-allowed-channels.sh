#!/usr/bin/env bash

# This script updates the 'allowed-channels' secret in Google Cloud Secret Manager
# with the contents of 'channels.txt' located at the repository root.
# It is intended for the ChatVibes (tts-twitch) project.

set -euo pipefail

# --- Configuration ---
# Defaults can be overridden via environment variables before invocation.
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-${PROJECT_ID:-chatvibestts}}"
SECRET_NAME="${SECRET_NAME:-allowed-channels}"
REGION="${REGION:-us-central1}"

# Resolve repository root relative to this script (scripts/..)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHANNELS_FILE="${CHANNELS_FILE:-${REPO_ROOT}/channels.txt}"

# --- Functions ---
function error() { echo "[ERROR] $*" >&2; }
function info() { echo "[INFO]  $*"; }

# --- Pre-flight checks ---
if ! command -v gcloud >/dev/null 2>&1; then
  error "gcloud CLI could not be found. Please install it and configure it."
  exit 1
fi

if [[ -z "${PROJECT_ID}" ]]; then
  error "PROJECT_ID is empty. Set GOOGLE_CLOUD_PROJECT or PROJECT_ID."
  exit 1
fi

if [[ ! -f "${CHANNELS_FILE}" ]]; then
  error "channels file not found: ${CHANNELS_FILE}"
  exit 1
fi

# --- Read and normalize channels ---
# - strip comments and blank lines
# - trim whitespace
# - lowercase
# - unique
# - join with comma
readarray -t CHANNEL_LINES < <(\
  grep -vE '^[[:space:]]*(#|$)' "${CHANNELS_FILE}" | \
  sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | \
  awk 'NF {print tolower($0)}' | \
  sort -u)

if [[ ${#CHANNEL_LINES[@]} -eq 0 ]]; then
  error "No channels found in ${CHANNELS_FILE}. The secret will not be updated."
  exit 1
fi

CHANNELS_COMMA_SEPARATED=$(printf "%s\n" "${CHANNEL_LINES[@]}" | paste -sd, -)

info "Project: ${PROJECT_ID}"
info "Secret:  ${SECRET_NAME}"
info "Region:  ${REGION}"
echo
info "The following channels will be set in the secret (normalized):"
printf ' - %s\n' "${CHANNEL_LINES[@]}"
echo
info "Comma-separated payload:"
echo "${CHANNELS_COMMA_SEPARATED}"
echo

# --- Ensure secret exists ---
if ! gcloud secrets describe "${SECRET_NAME}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  info "Secret '${SECRET_NAME}' does not exist. Creating it..."
  gcloud secrets create "${SECRET_NAME}" \
    --replication-policy="automatic" \
    --project="${PROJECT_ID}" \
    --quiet
fi

# --- Add a new version with updated channels ---
info "Updating secret: ${SECRET_NAME} in project: ${PROJECT_ID}..."
printf "%s" "${CHANNELS_COMMA_SEPARATED}" | \
  gcloud secrets versions add "${SECRET_NAME}" --data-file=- --project="${PROJECT_ID}" --quiet

info "Secret '${SECRET_NAME}' updated successfully."

echo
info "Cloud Run service should reference this secret via env 'ALLOWED_CHANNELS_SECRET_NAME':"
echo "  projects/${PROJECT_ID}/secrets/${SECRET_NAME}/versions/latest"
echo
info "The running service (e.g., 'chatvibes-tts-service' in ${REGION}) will pick up the new secret version on next instance start."

# --- Trigger Live Refresh (Optional) ---
if [[ -n "${CHATVIBES_SERVICE_URL:-}" ]] && [[ -n "${ADMIN_REFRESH_SECRET:-}" ]]; then
    info "Attempting to refresh allowlist in running service..."
    
    curl_response=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "x-admin-secret: ${ADMIN_REFRESH_SECRET}" \
        -H "Content-Type: application/json" \
        "${CHATVIBES_SERVICE_URL}/api/admin/refresh-allowlist" \
        2>/dev/null || true)
    
    if [[ -n "${curl_response}" ]]; then
        http_code=$(echo "${curl_response}" | sed -E 's/.*HTTPSTATUS:([0-9]{3})$/\1/')
        response_body=$(echo "${curl_response}" | sed -E 's/HTTPSTATUS:[0-9]{3}$//')
        
        if [[ "${http_code}" == "200" ]]; then
            info "✅ Successfully triggered live allowlist refresh in running service."
        else
            info "⚠️  Live refresh attempt failed (HTTP ${http_code}). Service will pick up changes on next restart."
            if [[ -n "${response_body}" ]]; then
                echo "Response: ${response_body}"
            fi
        fi
    else
        info "⚠️  Could not reach service for live refresh. Service will pick up changes on next restart."
    fi
else
    info "💡 To enable live refresh without restart, set environment variables:"
    info "   CHATVIBES_SERVICE_URL=https://your-service-url.run.app"
    info "   ADMIN_REFRESH_SECRET=your-admin-secret"
fi


