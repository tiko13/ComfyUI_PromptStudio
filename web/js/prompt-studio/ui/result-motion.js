// One bounded reveal for an inserted result. Never animate a progress repaint.
export function revealResult(node) {
  const view = node?.ownerDocument?.defaultView;
  if (!view || view.matchMedia('(prefers-reduced-motion: reduce)').matches || !node.animate || !node.isConnected) return;
  const duration = Number.parseFloat(view.getComputedStyle(node).getPropertyValue('--studio-motion-dialog')) || 180;
  const animation = node.animate([{opacity:0.65},{opacity:1}],{duration,easing:'ease-out'});
  const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
  const cancel = () => animation.cancel();
  preference.addEventListener('change',cancel,{once:true});
  animation.finished.catch(()=>{}).finally(()=>preference.removeEventListener('change',cancel));
}
