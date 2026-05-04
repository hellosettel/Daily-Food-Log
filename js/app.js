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
  const codeInput = document.getElementById('auth-code');
  const verifyBtn = document.getElementById('auth-verify');
  const backBtn = document.getElementById('auth-back');
  const codeMsg = document.getElementById('auth-code-message');
  const formEmail = document.getElementById('auth-form-email');
  const formCode = document.getElementById('auth-form-code');
  const emailDisplay = document.getElementById('auth-email-display');

  let pendingEmail = null;

  function showCodeForm(email) {
    pendingEmail = email;
    emailDisplay.textContent = email;
    formEmail.classList.add('hidden');
    formCode.classList.remove('hidden');
    codeMsg.textContent = '';
    codeMsg.classList.remove('error', 'success');
    codeInput.value = '';
    setTimeout(() => codeInput.focus(), 100);
  }

  function showEmailForm() {
    pendingEmail = null;
    formCode.classList.add('hidden');
    formEmail.classList.remove('hidden');
    msg.textContent = '';
    msg.classList.remove('error', 'success');
  }

  // Step 1: send code
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
      await Sync.sendOtpCode(email);
      showCodeForm(email);
    } catch (err) {
      msg.textContent = err.message || 'Something went wrong';
      msg.classList.add('error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send sign-in code';
    }
  });

  emailInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') submitBtn.click();
  });

  // Step 2: verify code
  verifyBtn.addEventListener('click', async () => {
    codeMsg.classList.remove('error', 'success');
    const token = codeInput.value.trim();
    if (!/^\d{6}$/.test(token)) {
      codeMsg.textContent = 'Enter the 6-digit code from your email';
      codeMsg.classList.add('error');
      return;
    }
    if (!pendingEmail) {
      codeMsg.textContent = 'Please request a new code';
      codeMsg.classList.add('error');
      return;
    }
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying…';
    try {
      await Sync.verifyOtpCode(pendingEmail, token);
      // The onAuthStateChange listener will swap to the app screen automatically.
    } catch (err) {
      codeMsg.textContent = err.message?.includes('expired') ? 'Code expired — request a new one' : 'Invalid code. Try again.';
      codeMsg.classList.add('error');
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify code';
    }
  });

  codeInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') verifyBtn.click();
  });

  // Auto-submit when 6 digits are entered
  codeInput.addEventListener('input', () => {
    const v = codeInput.value.replace(/\D/g, '');
    codeInput.value = v;
    if (v.length === 6) verifyBtn.click();
  });

  backBtn.addEventListener('click', showEmailForm);

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
