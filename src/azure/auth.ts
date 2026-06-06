/**
 * Build the HTTP Basic Authorization header for an Azure DevOps PAT.
 *
 * On-prem Azure DevOps Server authenticates PATs via HTTP Basic auth with an
 * empty username and the PAT as the password: base64(":" + PAT).
 * This mirrors the official microsoft/azure-devops-mcp `pat` handler.
 * Source: https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/authentication-guidance
 */
export function buildBasicAuthHeader(pat: string): string {
  const token = Buffer.from(`:${pat}`, "utf8").toString("base64");
  return `Basic ${token}`;
}
