/* GRACE website — tiny, dependency-free. */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Footer year ---------- */
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------- Copy buttons ---------- */
  var copyBtns = document.querySelectorAll(".copy-btn");
  copyBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        var original = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("is-copied");
        setTimeout(function () {
          btn.textContent = original;
          btn.classList.remove("is-copied");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          fallbackCopy(text, done);
        });
      } else {
        fallbackCopy(text, done);
      }
    });
  });

  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      /* ignore */
    }
    document.body.removeChild(ta);
    done();
  }

  /* ---------- Terminal animation ---------- */
  var typed = document.getElementById("t-typed");
  if (typed && !reduced) {
    var command = "Read vercel.json and find any errors.";
    var reveals = document.querySelectorAll(".t-reveal");
    var initialCursor = document.querySelector(".t-cmd-line .t-cursor");
    var i = 0;

    function typeNext() {
      if (i < command.length) {
        typed.textContent = command.slice(0, i + 1);
        i += 1;
        setTimeout(typeNext, 26);
      } else {
        if (initialCursor) initialCursor.style.display = "none";
        setTimeout(function () {
          reveals.forEach(function (el, idx) {
            setTimeout(function () {
              el.classList.add("is-visible");
            }, idx * 240);
          });
        }, 420);
      }
    }

    setTimeout(typeNext, 900);
  } else if (typed) {
    typed.textContent = "Read vercel.json and find any errors.";
    document.querySelectorAll(".t-reveal").forEach(function (el) {
      el.classList.add("is-visible");
    });
  }
})();
