const presentations = new WeakMap();

// Scrolling changes only the overlay offset. Keep text nodes and avoid layout
// writes when the highlight contents and dimensions have not changed.
export function renderTextHighlights({ editor, layer, content, ranges, wrapper }) {
  const text = editor.value;
  const signature = JSON.stringify(ranges);
  const previous = presentations.get(content);
  const width = `${editor.clientWidth}px`, height = `${editor.clientHeight}px`;
  const transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)`;
  if (!previous || previous.text !== text || previous.signature !== signature) {
    const doc = editor.ownerDocument, fragment = doc.createDocumentFragment();
    let offset = 0;
    for (const range of ranges) {
      fragment.append(doc.createTextNode(text.slice(offset, range.start)));
      const mark = doc.createElement('mark');
      mark.textContent = text.slice(range.start, range.end);
      fragment.append(mark);
      offset = range.end;
    }
    fragment.append(doc.createTextNode(`${text.slice(offset)}\n`));
    content.replaceChildren(fragment);
    editor.closest(wrapper)?.toggleAttribute('data-has-highlights', ranges.length > 0);
  }
  if (layer.style.width !== width) layer.style.width = width;
  if (layer.style.height !== height) layer.style.height = height;
  if (content.style.width !== width) content.style.width = width;
  if (content.style.transform !== transform) content.style.transform = transform;
  presentations.set(content, { text, signature });
}
