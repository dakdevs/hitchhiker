const nonce = crypto.randomUUID();
const counter = document.querySelector("#fixture-counter");
const increment = document.querySelector("#fixture-increment");
const nonceOutput = document.querySelector("#fixture-nonce");
let count = 0;

if (counter instanceof HTMLOutputElement) counter.value = String(count);
if (nonceOutput instanceof HTMLOutputElement) nonceOutput.value = nonce;
if (increment instanceof HTMLButtonElement && counter instanceof HTMLOutputElement) {
  increment.addEventListener("click", () => {
    count += 1;
    counter.value = String(count);
  });
}
