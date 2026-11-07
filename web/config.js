// Public by design: the project address and its public (anon) key only identify the project.
// Every read and write is checked in the database against the signed-in user. The secret service key is never here.
window.SPEEDY_CONFIG = {
  supabaseUrl: 'https://anrbdczpcrjgdrkkvyay.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFucmJkY3pwY3JqZ2Rya2t2eWF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwODAyMjgsImV4cCI6MjEwOTY1NjIyOH0.A8doJOWu_yu99KIA8SnEEibe4Y8IditY1vE_TyYgJ0Q',
  selfServiceReset: false,
};
