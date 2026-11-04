export function workflowLibrarySignature(profiles) {
  return JSON.stringify(profiles.map(profile => [profile.id,profile.path,profile.name,
    profile.cacheIdentity,Boolean(profile.stale),profile.error || '']));
}

// Only a missing or explicitly invalidated executable cache needs this read.
// Content and node/capability hashes are checked by the shared workflow adapter.
export async function refreshSelectedWorkflow(api, profile, build) {
  if (!profile?.path) return profile;
  const path = `workflows/${profile.path}`;
  let missing = false;
  try {
    const response = typeof api.getUserData === 'function'
      ? await api.getUserData(path)
      : await api.fetchApi(`/userdata/${encodeURIComponent(path)}`);
    missing = response.status === 404;
    if (!response.ok) throw new Error(`The selected workflow could not be read (${response.status}). Refresh workflows and select it again.`);
    return await build({ path: profile.path, modified: profile.sourceModified || 0 }, await response.json(), profile);
  } catch (error) {
    // Preserve the existing last-working-cache behavior on transient read or
    // conversion failures, but never resurrect a file explicitly deleted.
    if (!missing && profile.snapshot?.output) return {...profile,stale:true,error:error.message || String(error)};
    throw error;
  }
}
