const form = document.querySelector('#order');
const status = document.querySelector('#status');
function load() {
  try { return JSON.parse(localStorage.getItem('order') || '{}'); } catch { return {}; }
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  status.textContent = load().email === form.email.value ? 'Already sent.' : 'Thanks, we will reply soon.';
});
