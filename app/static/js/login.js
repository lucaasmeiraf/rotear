(function () {
  const senha = document.getElementById("senha");
  document.getElementById("ver-senha").addEventListener("click", () => {
    senha.type = senha.type === "password" ? "text" : "password";
    senha.focus();
  });
  document.getElementById("form-login").addEventListener("submit", (ev) => {
    ev.submitter && ev.submitter.classList.add("loading");
  });
})();
