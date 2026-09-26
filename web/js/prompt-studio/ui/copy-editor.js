// Use the document containing the editor, including a detached Studio window.
export async function copyEditorText(editor, feedback, successMessage = 'Copied.') {
  try {
    const clipboard = editor.ownerDocument.defaultView?.navigator?.clipboard;
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
    await clipboard.writeText(editor.value);
    feedback.textContent = successMessage;
    return true;
  } catch (_) {
    editor.focus();
    editor.select();
    feedback.textContent = 'Clipboard access is unavailable. The text is selected; use your browser’s Copy command.';
    return false;
  }
}
