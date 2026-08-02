export function createToast() {
  let timer = null;

  return function toast(message) {
    let element = document.getElementById('toast');
    if (!element) {
      element = document.createElement('div');
      element.id = 'toast';
      element.className = 'toast';
      document.body.appendChild(element);
    }
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => element.classList.remove('show'), 4000);
  };
}
