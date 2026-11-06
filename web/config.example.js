// Copy to config.js and fill in. Both values are public by design: the publishable key only
// identifies the project; every read and write is checked in the database against the signed-in user.
// Never put the service role (secret) key here.
window.SPEEDY_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseKey: 'sb_publishable_xxx',
  // true only after custom SMTP is set up in Supabase; otherwise "Forgot password" tells people to ask a manager
  selfServiceReset: false,
};
