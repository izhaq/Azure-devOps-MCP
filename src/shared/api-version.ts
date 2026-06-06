/**
 * Some Azure DevOps resources are only exposed under a preview `api-version`.
 * Derive the matching preview from the configured base version so an
 * operator-chosen version is respected (e.g. `6.0` → `6.0-preview.3`); a no-op
 * if a preview is already configured.
 *
 * Note: the preview `revision` is resource-specific and assumes the configured
 * version's family exposes that revision. If `ADO_API_VERSION` is set to an
 * older family whose revision differs for a given resource, override per call.
 */
export function toPreviewVersion(version: string, revision: number): string {
  return version.includes("-preview") ? version : `${version}-preview.${revision}`;
}
