(function () {
  'use strict';

  var form = document.getElementById('bis-form');
  if (!form) return;

  var statusEl = document.getElementById('form-status');
  var button = document.getElementById('bis-submit');
  var label = button ? button.querySelector('.button-label') : null;
  var spinner = button ? button.querySelector('.spinner') : null;
  var email = document.getElementById('email');
  var sku = document.getElementById('sku');
  var hiddenSku = form.querySelector('input[type="hidden"][name="sku"]');
  var busy = false;

  function setStatus(message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = 'form-status' + (kind ? ' form-status--' + kind : '');
  }

  function setBusy(value) {
    busy = value;
    if (!button) return;
    button.disabled = value;
    button.setAttribute('aria-busy', value ? 'true' : 'false');
    if (spinner) spinner.hidden = !value;
    if (label) label.textContent = value ? 'Adding you…' : 'Notify me when it’s back';
  }

  function currentSku() {
    if (hiddenSku) return hiddenSku.value;
    return sku ? sku.value : '';
  }

  if (sku && sku.tagName === 'SELECT') {
    sku.addEventListener('change', function () {
      var option = sku.options[sku.selectedIndex];
      if (option && option.getAttribute('data-in-stock') === 'true') {
        setStatus('This item is in stock right now — you can order it directly.', 'info');
      } else {
        setStatus('', '');
      }
    });
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;

    var emailValue = email ? email.value.trim() : '';
    var skuValue = currentSku().trim();

    if (!emailValue || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
      setStatus('Enter a valid email address.', 'error');
      if (email) {
        email.setAttribute('aria-invalid', 'true');
        email.focus();
      }
      return;
    }
    if (email) email.setAttribute('aria-invalid', 'false');

    if (!skuValue) {
      setStatus('Choose a product first.', 'error');
      if (sku) sku.focus();
      return;
    }

    setBusy(true);
    setStatus('Adding you to the list…', 'pending');

    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, 20000);

    try {
      var response = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: emailValue, sku: skuValue }),
        signal: controller.signal,
      });

      var data = null;
      try {
        data = await response.json();
      } catch (ignored) {
        data = null;
      }

      if (response.ok && data && data.ok) {
        form.classList.add('is-done');
        setStatus(data.message || 'You are on the list.', 'success');
        if (statusEl) {
          statusEl.classList.add('form-status--panel');
          try {
            statusEl.focus();
          } catch (ignored) {
            /* focus is best effort */
          }
        }
        if (email) email.disabled = true;
        if (sku) sku.disabled = true;
        if (button) button.hidden = true;
        return;
      }

      var message =
        data && data.error && data.error.message
          ? data.error.message
          : 'Something went wrong. Please try again.';

      if (response.status === 409) {
        setStatus(message, 'info');
        form.classList.add('is-done');
        if (email) email.disabled = true;
        if (sku) sku.disabled = true;
        if (button) button.hidden = true;
      } else {
        setStatus(message, 'error');
        if (response.status === 400 && email) {
          email.setAttribute('aria-invalid', 'true');
          email.focus();
        }
      }
    } catch (error) {
      setStatus('We could not reach the server. Check your connection and try again.', 'error');
    } finally {
      clearTimeout(timer);
      if (!form.classList.contains('is-done')) setBusy(false);
    }
  });
})();
