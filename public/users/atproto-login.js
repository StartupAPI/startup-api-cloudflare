// Login form behavior for the atproto handle form (served by AtprotoProvider.renderHandleForm):
// - Continue looks disabled (aria-disabled, still focusable) until the field holds a valid handle or
//   DID; pressing it early shows the browser's validation message, from the field's `pattern`.
// - Once submitted, the button is disabled and says "Logging in…" while we redirect to the user's
//   own server.
// - With data-typeahead="<endpoint>" on the input, typing asks our proxy for matching accounts and
//   lists them below Continue (never over it, so a late answer can't catch a click meant for the
//   button) as a group of "log in as" buttons: reachable with Tab or the arrow keys, announced to
//   screen readers, and left in place when focus moves. Picking one shows just that account in place
//   of the field and logs in with it.
// Without this script the form still works.

const DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;
const BUSY_LABEL = 'Logging in…';
const PATTERN_MESSAGE = 'Enter your full handle, like alice.bsky.social, or a DID.';

/** Avatar plus display name and handle, built with textContent only: they come from other people's profiles. */
function actorSummary(actor) {
  let avatar;
  if (actor.avatar) {
    avatar = document.createElement('img');
    avatar.src = actor.avatar;
    avatar.alt = '';
  } else {
    avatar = document.createElement('span');
  }
  avatar.className = 'avatar';
  const names = document.createElement('span');
  names.className = 'names';
  const displayName = document.createElement('span');
  displayName.className = 'display-name';
  displayName.textContent = actor.displayName || actor.handle;
  const handle = document.createElement('span');
  handle.className = 'handle';
  handle.textContent = `@${actor.handle}`;
  names.append(displayName, handle);
  return [avatar, names];
}

function enhanceForm(input) {
  const form = input.form;
  const button = form.querySelector('button[type="submit"]');
  const label = button.textContent;

  // The field's `pattern` and `required` decide validity, so the rule lives in one place and also
  // applies without this script.
  function updateButton() {
    input.setCustomValidity('');
    if (input.validity.patternMismatch) input.setCustomValidity(PATTERN_MESSAGE);
    button.setAttribute('aria-disabled', String(!input.validity.valid));
  }

  function setBusy(busy) {
    form.setAttribute('aria-busy', String(busy));
    button.textContent = busy ? BUSY_LABEL : label;
    button.disabled = busy; // only now truly disabled: the login is under way, don't send it twice
    if (!busy) updateButton();
  }

  input.addEventListener('input', updateButton);
  form.addEventListener('submit', () => setBusy(true));
  updateButton();

  const typeahead = input.dataset.typeahead ? enhanceTypeahead(input, button, updateButton) : null;

  // Coming back from the user's server, either the back/forward cache restores this page as we left
  // it (persisted), or it reloads and the browser refills the field after this script ran, without an
  // input event. Either way: editable again, with Continue matching what is in the field.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) typeahead?.reset();
    setBusy(false);
  });
}

function enhanceTypeahead(input, button, revalidate) {
  const endpoint = input.dataset.typeahead;

  // Suggestions go below Continue, in the page flow: the button never moves or gets covered.
  const suggestions = document.createElement('div');
  suggestions.className = 'suggestions';
  suggestions.setAttribute('role', 'group');
  suggestions.hidden = true;
  const heading = document.createElement('h2');
  heading.id = `${input.id}-suggestions-heading`;
  heading.textContent = 'Or pick your account';
  suggestions.setAttribute('aria-labelledby', heading.id);
  const list = document.createElement('ul');
  list.setAttribute('role', 'list'); // Safari drops list semantics from an unstyled list without it
  suggestions.append(heading, list);
  button.after(suggestions);

  // Tells screen reader users that accounts appeared, and where. It stays outside the hidden group:
  // changes inside hidden content are not announced.
  const status = document.createElement('p');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');

  // The account picked from the list, shown (and focused) in place of the field while we log in.
  const selected = document.createElement('div');
  selected.className = 'selected';
  selected.tabIndex = -1;
  selected.hidden = true;
  input.after(selected, status);

  // The browser's and password managers' own suggestion popups would cover ours. Until we have
  // suggestions to show, theirs are welcome (e.g. a handle saved from a past login); while ours are
  // listed, the field opts out of them.
  const browserAutocomplete = input.getAttribute('autocomplete');
  const PASSWORD_MANAGER_OPT_OUTS = { 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '' };

  function allowBrowserSuggestions(allow) {
    if (allow) {
      if (browserAutocomplete === null) input.removeAttribute('autocomplete');
      else input.setAttribute('autocomplete', browserAutocomplete);
    } else {
      input.setAttribute('autocomplete', 'off');
    }
    for (const [name, value] of Object.entries(PASSWORD_MANAGER_OPT_OUTS)) {
      if (allow) input.removeAttribute(name);
      else input.setAttribute(name, value);
    }
  }

  let timer = 0;
  let pending = null;

  const choices = () => [...list.querySelectorAll('button')];

  function pick(actor) {
    input.value = actor.handle; // set from code: no input event, so check it again ourselves
    revalidate();
    show([]);
    if (!input.validity.valid) {
      // Not something we can log in with (the aggregator sent a malformed handle): let the user see it.
      input.focus();
      return;
    }
    // The field stays in the form (hidden, still submitted); the account takes its place on screen.
    const label = document.createElement('span');
    label.className = 'visually-hidden';
    label.textContent = 'Logging in as';
    selected.replaceChildren(label, ...actorSummary(actor));
    selected.hidden = false;
    input.hidden = true;
    selected.focus();
    input.form.requestSubmit();
  }

  /** List these accounts (none hides the list), and say so to screen reader users. */
  function show(actors) {
    list.replaceChildren(
      ...actors.map((actor) => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.append(...actorSummary(actor));
        choice.addEventListener('click', () => pick(actor));
        const item = document.createElement('li');
        item.append(choice);
        return item;
      }),
    );
    suggestions.hidden = actors.length === 0;
    allowBrowserSuggestions(actors.length === 0);
    status.textContent = actors.length
      ? `${actors.length === 1 ? '1 account' : `${actors.length} accounts`} found below the Continue button. Press Down Arrow to choose.`
      : '';
  }

  async function search(q) {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    try {
      const res = await fetch(`${endpoint}?q=${encodeURIComponent(q)}`, { signal: controller.signal });
      const body = res.ok ? await res.json() : { actors: [] };
      if (pending !== controller) return; // a newer keystroke owns the list now
      show(Array.isArray(body.actors) ? body.actors : []);
    } catch {
      // Aborted by a newer query, or the network failed: just show no suggestions.
      if (pending === controller) show([]);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim().replace(/^@/, '');
    if (q.length < MIN_QUERY_LENGTH || q.startsWith('did:')) {
      pending?.abort();
      pending = null;
      show([]);
      return;
    }
    timer = setTimeout(() => search(q), DEBOUNCE_MS);
  });

  // Arrow keys move between the field and the accounts; Escape goes back to the field and closes the
  // list. Tab works too, as each account is a button.
  input.addEventListener('keydown', (event) => {
    if (suggestions.hidden) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      choices()[0]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      show([]);
    }
  });

  list.addEventListener('keydown', (event) => {
    const all = choices();
    const index = all.indexOf(document.activeElement);
    if (index === -1) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      all[Math.min(index + 1, all.length - 1)].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      (index === 0 ? input : all[index - 1]).focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      all[0].focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      all[all.length - 1].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      input.focus();
      show([]);
    }
  });

  return {
    /** Show the field again in place of a picked account. */
    reset() {
      selected.hidden = true;
      selected.replaceChildren();
      input.hidden = false;
    },
  };
}

const handleInput = document.getElementById('handle');
if (handleInput?.form) enhanceForm(handleInput);
