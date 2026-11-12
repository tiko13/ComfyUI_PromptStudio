import { createFeatureController } from './feature-controller.js';

// Shared by both studios. CSS owns breakpoints; focus follows the actual drawer
// presentation, including rotation, split view and moving to a popout document.
export function createResponsiveShell({ panel: getPanel, drawers }) {
  return createFeatureController({
    mount(doc, scope) {
      const view = doc.defaultView;
      let active = null;
      let trigger = null;
      let lastDrawerFocus = null;
      const floatingState = new WeakMap();
      const disclosureState = new WeakMap();
      const visible = node => node?.getClientRects().length && view.getComputedStyle(node).visibility !== 'hidden';
      const focusable = node => [...node.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter(el => !el.disabled && el.tabIndex >= 0 && visible(el) && !el.closest('[inert]'));
      const sync = () => {
        const panel = getPanel();
        if (!panel || panel.ownerDocument !== doc) return;
        // Keep pinch zoom intact; only keyboard/browser-chrome resizing changes
        // the usable shell height. No window scroll or focus is forced here.
        if (!view.visualViewport || view.visualViewport.scale === 1) {
          panel.style.setProperty('--studio-viewport-height', `${view.visualViewport?.height || view.innerHeight}px`);
        }
        let next = null;
        for (const drawer of drawers) {
          const node = panel.querySelector(drawer.selector);
          if (!node) continue;
          const floating = view.getComputedStyle(node).position === 'absolute';
          // Rotation must not hide the field being edited, or the opener of a
          // modal currently above that field. Reveal its newly floating drawer.
          if (visible(panel) && floating && floatingState.get(node) === false && !panel.matches(drawer.open)
            && (node.contains(doc.activeElement)
              || (doc.querySelector('dialog[open]') && node.contains(lastDrawerFocus)))) {
            panel.querySelector(drawer.trigger)?.click();
          }
          floatingState.set(node, floating);
          const open = floating && panel.matches(drawer.open);
          node.inert = floating && !open;
          if (open) next = node;
        }
        // An open drawer is the active navigation surface, including for
        // screen readers. Native top-layer dialogs remain outside this region.
        const main = panel.querySelector(':scope > main');
        if (main) main.inert = Boolean(next);
        for (const drawer of drawers) {
          const node = panel.querySelector(drawer.selector);
          if (!node) continue;
          node.inert = next ? next !== node : floatingState.get(node) && !panel.matches(drawer.open);
          if (node === next) { node.dataset.studioDrawerModal=''; node.setAttribute('role','dialog'); node.setAttribute('aria-modal','true'); node.setAttribute('aria-label',drawer.label); }
          else { delete node.dataset.studioDrawerModal; node.removeAttribute('role'); node.removeAttribute('aria-modal'); node.removeAttribute('aria-label'); }
        }
        for (const node of panel.querySelectorAll('[data-studio-disclosure]')) {
          const query = node.dataset.studioDisclosureQuery || (node.dataset.studioDisclosure === 'phone'
            ? '(max-width: 780px), (max-width: 900px) and (max-height: 600px)'
            : '(max-width: 1400px), (any-pointer: coarse)');
          const collapsed = view.matchMedia(query).matches;
          if (disclosureState.get(node) !== collapsed) {
            node.open = !collapsed || node.contains(doc.activeElement);
            disclosureState.set(node,collapsed);
          }
        }
        if (next === active) return;
        const previous = active;
        active = next;
        if (active) {
          if (!previous) {
            const descriptor = drawers.find(drawer => active.matches(drawer.selector));
            trigger = active.contains(doc.activeElement) || doc.querySelector('dialog[open]')
              ? panel.querySelector(descriptor.trigger) : doc.activeElement;
          }
          if (!active.contains(doc.activeElement) && !doc.querySelector('dialog[open]')) {
            focusable(active)[0]?.focus({ preventScroll: true });
          }
        } else if (previous && (previous.contains(doc.activeElement)
          || doc.activeElement?.matches('.promptstudio-mobile-scrim, .psvstudio-drawer-scrim'))) {
          if (visible(trigger)) trigger.focus({ preventScroll: true });
          else focusable(panel).find(el => !previous.contains(el))?.focus({ preventScroll: true });
          trigger = null;
        }
      };
      const panel = getPanel();
      if (!panel) return;
      scope.own(() => {
        panel.querySelector(':scope > main')?.removeAttribute('inert');
        for (const drawer of drawers) {
          const node=panel.querySelector(drawer.selector);
          if(node){node.inert=false;delete node.dataset.studioDrawerModal;node.removeAttribute('role');node.removeAttribute('aria-modal');node.removeAttribute('aria-label');}
        }
      });
      // Header-only swipes never compete with scrolling, sliders, text editing
      // or the OS back gesture at the edge of the display.
      for (const drawer of drawers) {
        const node=panel.querySelector(drawer.selector), handle=node?.querySelector(drawer.handle);
        if(!handle)continue;
        handle.classList.add('studio-drawer-drag-header');
        let drag=null;
        const reset=()=>{node.style.removeProperty('transform');node.classList.remove('studio-drawer-dragging');drag=null;};
        scope.own(reset);
        scope.listen(handle,'pointerdown',event=>{
          if(event.pointerType!=='touch'||active!==node||event.target.closest('button,input,select,textarea,a,summary'))return;
          const rect=node.getBoundingClientRect();
          drag={id:event.pointerId,x:event.clientX,y:event.clientY,time:event.timeStamp,direction:drawer.side==='left'?-1:1,width:rect.width};
          handle.setPointerCapture(event.pointerId);
        });
        scope.listen(handle,'touchstart',event=>{if(drag)event.preventDefault();},{passive:false});
        scope.listen(handle,'touchmove',event=>{if(drag)event.preventDefault();},{passive:false});
        scope.listen(handle,'pointermove',event=>{
          if(drag?.id!==event.pointerId)return;
          const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
          if(Math.abs(dy)>Math.abs(dx)&&!node.classList.contains('studio-drawer-dragging')){reset();return;}
          if(dx*drag.direction>8){node.classList.add('studio-drawer-dragging');node.style.transform=`translateX(${dx}px)`;}
        });
        const finish=event=>{
          if(drag?.id!==event.pointerId)return;
          const dx=(event.clientX-drag.x)*drag.direction,velocity=dx/Math.max(1,event.timeStamp-drag.time);
          const close=event.type!=='pointercancel'&&(dx>drag.width*.28||(dx>40&&velocity>.65));
          reset();if(close)panel.querySelector(drawer.trigger)?.click();
        };
        scope.listen(handle,'pointerup',finish);scope.listen(handle,'pointercancel',finish);
      }
      const menus=()=>[...panel.querySelectorAll('[data-studio-menu][open]')].filter(node=>disclosureState.get(node)&&visible(node.querySelector('summary'))&&!panel.hidden);
      scope.listen(doc,'pointerdown',event=>{
        for(const node of menus())if(!node.contains(event.target)){
          node.open=false;
          if(node.contains(doc.activeElement)&&!event.target.closest('button,input,textarea,select,a,summary,[tabindex]'))node.querySelector('summary')?.focus({preventScroll:true});
        }
      });
      scope.listen(panel,'click',event=>{
        const menu=event.target.closest('[data-studio-menu]');
        if(menu&&disclosureState.get(menu)&&event.target.closest('button')){
          menu.open=false;
          if(!doc.querySelector('dialog[open], [aria-modal="true"]'))menu.querySelector('summary')?.focus({preventScroll:true});
        }
      });
      scope.listen(doc,'keydown',event=>{
        if(event.key!=='Escape'||doc.querySelector('dialog[open], [aria-modal="true"]'))return;
        const menu=menus().at(-1);if(!menu)return;
        event.preventDefault();event.stopImmediatePropagation();menu.open=false;menu.querySelector('summary')?.focus({preventScroll:true});
      },{capture:true});
      const observer = new view.MutationObserver(sync);
      observer.observe(panel, { attributes: true, attributeFilter: ['class', 'data-drawer', 'hidden'] });
      scope.own(() => observer.disconnect());
      scope.listen(view, 'resize', sync);
      if (view.visualViewport) scope.listen(view.visualViewport, 'resize', sync);
      scope.listen(doc, 'focusin', event => {
        if (event.target.closest?.('dialog, [role="dialog"]:not([data-studio-drawer-modal])')) return;
        lastDrawerFocus = drawers.some(drawer => panel.querySelector(drawer.selector)?.contains(event.target))
          ? event.target : null;
      });
      scope.listen(doc, 'keydown', event => {
        if (event.key !== 'Tab' || !active || !visible(active) || panel.hidden) return;
        // A nested/top-layer modal keeps its own focus management.
        if (doc.querySelector('dialog[open]') || event.target.closest?.('[role="dialog"]:not([data-studio-drawer-modal])')) return;
        const items = focusable(active);
        const index = items.indexOf(doc.activeElement);
        if (index < 0 || (!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0)) {
          event.preventDefault();
          (event.shiftKey ? items.at(-1) : items[0])?.focus();
        }
      });
      sync();
    },
  });
}
