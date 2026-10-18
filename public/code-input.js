(() => {
  const input = document.getElementById('code');
  const entry = input.closest('.code-entry');
  const slots = [...entry.querySelectorAll('.code-slots span')];

  function render() {
    const focused = document.activeElement === input;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    slots.forEach((slot, index) => {
      slot.textContent = input.value[index] || '';
      slot.classList.toggle('filled', Boolean(input.value[index]));
      slot.classList.toggle('active', focused && (start === end ? index === Math.min(start, 3) : index >= start && index < end));
    });
  }

  entry.classList.add('enhanced');
  for (const event of ['input', 'focus', 'blur', 'keyup', 'select']) input.addEventListener(event, render);
  input.addEventListener('click', event => {
    const index = slots.findIndex(slot => event.clientX <= slot.getBoundingClientRect().right);
    const position = Math.min(index < 0 ? 4 : index, input.value.length);
    input.setSelectionRange(position, position);
    render();
  });
  input.form.addEventListener('reset', () => requestAnimationFrame(render));
  window.addEventListener('pageshow', render);
  render();
})();
