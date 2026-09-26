// A successful HTTP status alone must never acknowledge or erase a local draft.
export function validateStoreResponse(data, collection = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)
      || !Number.isSafeInteger(data.revision) || data.revision < 0
      || (collection && !Array.isArray(data[collection]))) {
    throw new Error("The server returned an invalid history response. Your local draft has been retained. Retry when ComfyUI is available.");
  }
  return data;
}
