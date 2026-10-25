(() => {
const BUTTON_TEXT = 'VOLGENDE';
const SELECTOR = 'button,[role="button"],input[type="button"],input[type="submit"],a';
const normalize = value => String(value || '').replace(/\s+/g, ' ').trim().toLocaleUpperCase();

function findButtons() {
  return [...document.querySelectorAll(SELECTOR)].filter(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const labels = [element.innerText, element.getAttribute('aria-label'), element.value, element.getAttribute('title')];
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
      labels.some(label => normalize(label) === BUTTON_TEXT);
  });
}
function findSubmitButtons() {
  return [...document.querySelectorAll(SELECTOR)].filter(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const labels = [element.innerText, element.getAttribute('aria-label'), element.value, element.getAttribute('title')];
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' &&
      labels.some(label => normalize(label) === 'INLEVEREN');
  });
}
function isLastQuestion() {
  const header = document.querySelector('.app-header,header');
  const match = (header?.innerText || '').match(/vraag\s+(\d+)\s+van\s+(\d+)/i);
  return Boolean(match && Number(match[1]) === Number(match[2]));
}
function isFinalQuestionState(nextButtons, submitButtons) {
  return isLastQuestion() && submitButtons.length === 1 && !isDisabled(submitButtons[0]) &&
    (nextButtons.length === 0 || (nextButtons.length === 1 && isDisabled(nextButtons[0])));
}

function isDisabled(element) {
  return Boolean(element.disabled || element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true');
}

if (globalThis.__nt2ObserverMessageListener) {
  chrome.runtime.onMessage.removeListener(globalThis.__nt2ObserverMessageListener);
}
globalThis.__nt2ObserverMessageListener = (message, sender, reply) => {
  if (message?.to !== 'observer') return;
  if (message.type === 'stop') {
    window.__nt2RecorderObserver?.stop();
    reply({ ok: true });
    return;
  }
  if (message.type !== 'start') return;

  window.__nt2RecorderObserver?.stop();
  let stopped = false;
  let lastDisabled = true;
  let missingTimer, enabledTimer, finalTimer, finalSent = false;

  const send = event => chrome.runtime.sendMessage({ to: 'worker', type: 'page-event', event }).catch(() => {});

  function inspect() {
    if (stopped) return;
    const buttons = findButtons();
    const submitButtons = findSubmitButtons();
    const finalReady = !finalSent && isFinalQuestionState(buttons, submitButtons);
    if (finalReady) {
      clearTimeout(missingTimer);
      clearTimeout(enabledTimer);
      finalTimer ??= setTimeout(() => {
        finalTimer = null;
        if (stopped) return;
        const currentNext = findButtons(), currentSubmit = findSubmitButtons();
        if (!finalSent && isFinalQuestionState(currentNext, currentSubmit)) {
          finalSent = true;
          send({ name: 'final-ready' });
        }
      }, 1500);
      return;
    }
    clearTimeout(finalTimer);
    finalTimer = null;
    if (buttons.length !== 1) {
      clearTimeout(missingTimer);
      missingTimer = setTimeout(() => {
        if (stopped) return;
        const currentNext = findButtons(), currentSubmit = findSubmitButtons();
        if (isFinalQuestionState(currentNext, currentSubmit)) return;
        if (currentNext.length !== 1) send({ name: 'observer-error', message: `VOLGENDE 控件匹配数变为 ${currentNext.length}，且未检测到可用的 INLEVEREN 按钮。` });
      }, 500);
      return;
    }
    clearTimeout(missingTimer);
    const disabled = isDisabled(buttons[0]);
    if (disabled) {
      clearTimeout(enabledTimer);
      enabledTimer = null;
    } else if (lastDisabled) {
      clearTimeout(enabledTimer);
      enabledTimer = setTimeout(() => {
        enabledTimer = null;
        if (stopped) return;
        const current = findButtons();
        if (current.length === 1 && !isDisabled(current[0])) send({ name: 'enabled' });
      }, 1000);
    }
    lastDisabled = disabled;
  }

  const observer = new MutationObserver(inspect);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const onClick = event => {
    const target = event.target instanceof Element ? event.target.closest(SELECTOR) : null;
    if (!target || isDisabled(target)) return;
    if (findButtons().includes(target)) {
      send({ name: 'next-click' });
      return;
    }
    if (findSubmitButtons().includes(target) && isFinalQuestionState(findButtons(), findSubmitButtons())) {
      if (!finalSent) {
        finalSent = true;
        send({ name: 'final-ready' });
      }
    }
  };
  document.addEventListener('click', onClick, true);

  window.__nt2RecorderObserver = {
    stop() {
      stopped = true;
      clearTimeout(missingTimer);
      clearTimeout(enabledTimer);
      clearTimeout(finalTimer);
      observer.disconnect();
      document.removeEventListener('click', onClick, true);
      delete window.__nt2RecorderObserver;
    }
  };

  const buttons = findButtons();
  if (buttons.length !== 1) {
    send({ name: 'observer-error', message: `VOLGENDE 控件匹配数为 ${buttons.length}；需要恰好一个。` });
  } else {
    // Start was allowed only after the worker observed a disabled button.
    // If it became enabled during recorder setup, preserve that transition.
    lastDisabled = true;
    inspect();
  }
  reply({ ok: true });
};
chrome.runtime.onMessage.addListener(globalThis.__nt2ObserverMessageListener);
})();
