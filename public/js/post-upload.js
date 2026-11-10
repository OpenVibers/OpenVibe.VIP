/* VIP's post picture: the shared picker and progress meter, then the post form's own multipart endpoint.
   The dashboard loads openvibe-shared/ov-upload.js and ov-upload.css. Without a picture the form posts as it
   always did; with one, the same form goes by XHR so the person sees bytes and time left. */
(function () {
  'use strict';
  var root = document.querySelector('[data-post-upload]');
  var form = root && root.closest('form');
  if (!root || !form || !window.OVUpload) return;
  var status = form.querySelector('[data-post-upload-status]');
  var progressEl = form.querySelector('[data-post-upload-progress]');
  var meter = progressEl ? window.OVUpload.progress(progressEl) : null;
  var file = null, busy = false;
  function say(text, bad) { if (status) { status.textContent = text || ''; status.classList.toggle('error', !!bad); } }
  window.OVUpload.picker(root, {
    label: 'Choose a picture', accept: root.getAttribute('data-accept') || 'image/*',
    onFile: function (f) { file = f; say('Ready to publish with ' + f.name + '.'); },
    onRemove: function () { file = null; say(''); }
  });
  form.addEventListener('submit', function (e) {
    if (!file || busy) return;
    e.preventDefault();
    busy = true;
    var button = form.querySelector('button[type=submit]');
    if (button) button.disabled = true;
    var fd = new FormData(form);
    fd.append('image', file, file.name);
    if (progressEl) progressEl.hidden = false;
    if (meter) meter.update({ state: 'sending', done: 0, total: file.size });
    say('Publishing with ' + file.name + '…');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', form.getAttribute('action') || location.pathname);
    xhr.withCredentials = true;
    xhr.upload.onprogress = function (ev) { if (ev.lengthComputable && meter) meter.update({ state: 'sending', done: ev.loaded, total: ev.total }); };
    xhr.onload = function () {
      busy = false;
      if (button) button.disabled = false;
      if (xhr.status >= 200 && xhr.status < 400) {
        if (meter) meter.update({ state: 'done', done: file.size, total: file.size });
        location.assign(xhr.responseURL || (form.getAttribute('action') || location.href));
        return;
      }
      var message = 'The picture did not publish (' + xhr.status + ').';
      if (meter) meter.update({ state: 'failed', message: message });
      say(message, true);
    };
    xhr.onerror = function () {
      busy = false;
      if (button) button.disabled = false;
      var message = 'The connection dropped. Try again.';
      if (meter) meter.update({ state: 'failed', message: message });
      say(message, true);
    };
    xhr.send(fd);
  });
})();
