/* ============================================================
   app.js — entry point
   ============================================================ */

(async function () {

  // Open IndexedDB ASAP
  await DB.openDB();

  // Bind auth screen
  const emailInput = document.getElementById('auth-email');
  const submitBtn = document.getElementById('auth-submit');
  const msg = document.getElementById('auth-message');

  submitBtn.addEventListener('click', async () => {
    msg.classList.remove('error', 'success');
    const email = emailInput.value.trim();
    if (!email || !email.includes('@')) {
      msg.textContent = 'Enter a valid email';
      msg.classList.add('error');
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      await Sync.sendMagicLink(email);
      msg.textContent = `Check ${email} for a sign-in link.`;
      msg.classList.add('success');
    } catch (err) {
      msg.textContent = err.message || 'Something went wrong';
      msg.classList.add('error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send magic link';
    }
  });

  emailInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') submitBtn.click();
  });

  // Helper to swap between screens
  function showAuth() {
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
  }

  function showApp() {
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
  }

  // Configuration check
  if (!Sync.isConfigured()) {
    document.getElementById('loading-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    msg.textContent = 'Edit /js/config.js with your Supabase URL + anon key.';
    msg.classList.add('error');
    submitBtn.disabled = true;
    return;
  }

  // Init Supabase auth
  await Sync.init(async (user) => {
    if (user) {
      showApp();
      await UI.initUI();
    } else {
      showAuth();
    }
  });

})();
