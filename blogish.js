/*
 * blogish.js
 *
 * Renders a page written as plain Markdown mixed with raw HTML (images,
 * YouTube embeds, etc.). Drop the Markdown into the <body> and add a single
 * <script src="blogish.js"></script> at the bottom. On load this script reads
 * the raw body, converts the Markdown to HTML while leaving embedded HTML
 * untouched, wraps the result in an <article>, and swaps it back into the page.
 *
 * No dependencies, vanilla JavaScript.
 */
(function () {
	"use strict";

	// The URL of this script, captured while it's the currently executing
	// script. Used to resolve sibling assets (style.css) regardless of where
	// the post lives on disk.
	var SELF = document.currentScript ? document.currentScript.src : "";

	// ---------------------------------------------------------------------
	// 0. Inject the stylesheet (a sibling of this script).
	// ---------------------------------------------------------------------
	function injectStyles() {
		if (!SELF) {
			return;
		}
		var href = SELF.replace(/[^/]*$/, "style.css");
		// Avoid a duplicate link if the script somehow runs twice.
		if (document.querySelector('link[href="' + href + '"]')) {
			return;
		}
		var link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = href;
		document.getElementsByTagName("head")[0].appendChild(link);
	}

	// ---------------------------------------------------------------------
	// 0b. Theme toggle (light / dark).
	//
	// The active theme is just a `.dark` class on <body>. We pick the initial
	// theme from the reader's saved choice, falling back to their OS setting,
	// then let a floating sun/moon button flip it and remember the choice.
	// ---------------------------------------------------------------------
	var THEME_KEY = "blogish-theme";
	var syncToggle = function () {}; // set once the toggle button exists
	// \u escapes keep this source pure-ASCII, so the icons decode correctly
	// even when a post declares no charset and the browser falls back to Latin-1.
	var SUN = "\u2600"; // ☀ shown while dark  -> click for light
	var MOON = "\u263E"; // ☾ shown while light -> click for dark

	function savedTheme() {
		try {
			return localStorage.getItem(THEME_KEY);
		} catch (e) {
			return null;
		}
	}

	function prefersDark() {
		return !!(
			window.matchMedia &&
			window.matchMedia("(prefers-color-scheme: dark)").matches
		);
	}

	function applyTheme(mode) {
		document.body.classList.toggle("dark", mode === "dark");
	}

	function injectThemeToggle() {
		var btn = document.createElement("button");
		btn.type = "button";
		btn.className = "theme-toggle";
		btn.setAttribute("aria-label", "Toggle dark mode");

		function sync() {
			btn.textContent = document.body.classList.contains("dark")
				? SUN
				: MOON;
		}
		syncToggle = sync;
		sync();

		btn.addEventListener("click", function () {
			var next = document.body.classList.contains("dark")
				? "light"
				: "dark";
			applyTheme(next);
			sync();
			try {
				localStorage.setItem(THEME_KEY, next);
			} catch (e) {
				/* storage unavailable — toggle still works for this page */
			}
		});

		document.body.appendChild(btn);
	}

	// ---------------------------------------------------------------------
	// 1. Read the raw source out of the DOM.
	//
	// The browser parses the loose Markdown into a flat list of child nodes:
	// long runs of Markdown become text nodes, while embedded tags like
	// <img> and <iframe> become element nodes. We rebuild a single source
	// string from those nodes:
	//   - text nodes contribute their unescaped text (so `&`, `<`, `>` inside
	//     code fences survive verbatim), and
	//   - element nodes contribute their serialized outerHTML, padded with
	//     blank lines so they always read as standalone blocks.
	// The <script> that loaded us (and any <style>) is skipped.
	//
	// An element gets one of three treatments:
	//   - inside an inline `code` span: a real tag written as code, e.g.
	//     `<img>`, is parsed by the browser into an element node *before* we
	//     run, so the backticks land in the text nodes on either side of it.
	//     We emit its raw markup as text (never skipped, never block-padded)
	//     so inline() re-escapes it into a visible <code>.
	//   - alone on its line: a genuine block embed (<img>, <iframe>), padded
	//     with blank lines so it reads as a standalone block.
	//   - mid-line: an inline element, e.g. the <a> in "- <a href=..>x</a>".
	//     Block padding would tear it out of its list item or paragraph, but
	//     we can't drop it into the line as raw markup either — inline()
	//     escapes everything it is handed, which would render the tag as
	//     visible text. So we swap in a placeholder that survives escaping and
	//     restore the real markup once parsing is done.
	// ---------------------------------------------------------------------

	// Inline elements pulled out of the source, indexed by placeholder. NUL
	// can't appear in author text, so the token can never collide with it and
	// passes through escapeHtml() and the Markdown patterns untouched.
	var RAW = [];
	var RE_RAW = /\u0000raw(\d+)\u0000/g;

	function stashRaw(html) {
		RAW.push(html);
		return "\u0000raw" + (RAW.length - 1) + "\u0000";
	}

	function restoreRaw(s) {
		return s.replace(RE_RAW, function (_, i) {
			return RAW[Number(i)];
		});
	}

	// True when nothing but horizontal whitespace precedes the element on its
	// line, i.e. it is the first thing on that line.
	function atLineStart(parts) {
		for (var i = parts.length - 1; i >= 0; i--) {
			var s = parts[i];
			for (var j = s.length - 1; j >= 0; j--) {
				var ch = s.charAt(j);
				if (ch === "\n") {
					return true;
				}
				if (ch !== " " && ch !== "\t") {
					return false;
				}
			}
		}
		return true; // nothing before it at all
	}

	// True when nothing but horizontal whitespace follows the element on its
	// line, i.e. it is the last thing on that line.
	function atLineEnd(node) {
		var next = node.nextSibling;
		while (next) {
			if (next.nodeType === 3) {
				var s = next.nodeValue;
				for (var j = 0; j < s.length; j++) {
					var ch = s.charAt(j);
					if (ch === "\n") {
						return true;
					}
					if (ch !== " " && ch !== "\t") {
						return false;
					}
				}
			} else if (next.nodeType === 1) {
				// Another element shares the line (the loader <script> and
				// any <style> don't count — they render nothing).
				if (next.tagName !== "SCRIPT" && next.tagName !== "STYLE") {
					return false;
				}
			}
			next = next.nextSibling;
		}
		return true; // nothing after it at all
	}

	// Toggle inline-code state across a chunk of text. Only a run of a single
	// backtick opens or closes an inline span; longer runs are fences (```) or
	// literal backticks and are left alone.
	function trackCode(text, inCode) {
		var i = 0;
		var n = text.length;
		while (i < n) {
			if (text.charAt(i) !== "`") {
				i++;
				continue;
			}
			var start = i;
			while (i < n && text.charAt(i) === "`") {
				i++;
			}
			if (i - start === 1) {
				inCode = !inCode;
			}
		}
		return inCode;
	}

	// Rebuild just the tag the author typed, dropping any children the browser
	// decided to adopt into it.
	function openTag(node) {
		var s = "<" + node.tagName.toLowerCase();
		var attrs = node.attributes;
		for (var i = 0; i < attrs.length; i++) {
			s += " " + attrs[i].name + '="' + attrs[i].value + '"';
		}
		return s + ">";
	}

	function walk(root, parts, state) {
		var node = root.firstChild;

		while (node) {
			if (node.nodeType === 3) {
				// Text node.
				parts.push(node.nodeValue);
				state.inCode = trackCode(node.nodeValue, state.inCode);
			} else if (node.nodeType === 1) {
				// Element node.
				if (state.inCode) {
					// Written as inline code (`<img>`): keep it as literal
					// markup so inline() escapes it into a visible <code>.
					if (node.textContent.indexOf("`") === -1) {
						parts.push(node.outerHTML);
					} else {
						// The span's closing backtick is *inside* this
						// element, so it swallowed text meant to follow it —
						// what an unclosed block tag like `<p>` does. Emit the
						// tag on its own and carry on through the children as
						// the siblings they were written as, otherwise their
						// markup gets serialized to entities here and escaped
						// a second time by inline().
						parts.push(openTag(node));
						walk(node, parts, state);
					}
				} else if (node.tagName !== "SCRIPT" && node.tagName !== "STYLE") {
					if (atLineStart(parts) && atLineEnd(node)) {
						// Alone on its line: a standalone block embed.
						parts.push("\n\n" + node.outerHTML + "\n\n");
					} else {
						// Mid-line: keep it in place so it stays inside its
						// list item / paragraph, and shield it from escaping.
						parts.push(stashRaw(node.outerHTML));
					}
				}
			}
			node = node.nextSibling;
		}
	}

	function readSource(root) {
		var parts = [];

		RAW.length = 0;
		walk(root, parts, { inCode: false });

		return parts.join("");
	}

	// ---------------------------------------------------------------------
	// 2. Inline formatting (runs inside a single block of text).
	// ---------------------------------------------------------------------
	function escapeHtml(s) {
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	}

	function inline(text) {
		// Escape first so author text can never inject markup, then layer the
		// Markdown constructs on top. The escaped `&lt;`/`&gt;` don't interfere
		// with the patterns below.
		var s = escapeHtml(text);

		// Inline code: `code`
		s = s.replace(/`([^`]+)`/g, function (_, code) {
			return "<code>" + code + "</code>";
		});

		// Images: ![alt](url)
		s = s.replace(
			/!\[([^\]]*)\]\(([^)\s]+)\)/g,
			'<img src="$2" alt="$1">'
		);

		// Links: [text](url)
		s = s.replace(
			/\[([^\]]+)\]\(([^)\s]+)\)/g,
			'<a href="$2">$1</a>'
		);

		// Bold: **text** or __text__
		s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
		s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");

		// Italic: *text* or _text_
		s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
		s = s.replace(/_([^_]+)_/g, "<em>$1</em>");

		return s;
	}

	// ---------------------------------------------------------------------
	// 2b. Tiny syntax highlighter.
	//
	// A single left-to-right scan over the code. We don't need a real parser:
	// strings and comments don't nest, so at any point we're either in plain
	// code or consuming one token (comment / string) until its terminator.
	// The per-language table below just says which markers open those tokens.
	//   line:  line-comment prefixes (consume to end of line)
	//   block: [open, close] block-comment pairs
	//   quotes: characters that open a string (closed by the same char)
	// ---------------------------------------------------------------------
	var LANGS = {
		_default: {
			line: ["//", "#"],
			block: [["/*", "*/"]],
			quotes: ["\"", "'", "`"]
		},
		js: { line: ["//"], block: [["/*", "*/"]], quotes: ["\"", "'", "`"] },
		ts: { line: ["//"], block: [["/*", "*/"]], quotes: ["\"", "'", "`"] },
		go: { line: ["//"], block: [["/*", "*/"]], quotes: ["\"", "'", "`"] },
		c: { line: ["//"], block: [["/*", "*/"]], quotes: ["\"", "'"] },
		java: { line: ["//"], block: [["/*", "*/"]], quotes: ["\"", "'"] },
		rust: { line: ["//"], block: [["/*", "*/"]], quotes: ["\"", "'"] },
		css: { line: [], block: [["/*", "*/"]], quotes: ["\"", "'"] },
		bash: { line: ["#"], block: [], quotes: ["\"", "'"] },
		sh: { line: ["#"], block: [], quotes: ["\"", "'"] },
		shell: { line: ["#"], block: [], quotes: ["\"", "'"] },
		python: { line: ["#"], block: [], quotes: ["\"", "'"] },
		py: { line: ["#"], block: [], quotes: ["\"", "'"] },
		ruby: { line: ["#"], block: [], quotes: ["\"", "'"] },
		rb: { line: ["#"], block: [], quotes: ["\"", "'"] },
		sql: { line: ["--"], block: [["/*", "*/"]], quotes: ["'"] }
	};

	// Operators / punctuation we paint as "symbols".
	var RE_SYMBOL = /[{}()[\].,;:+\-*/%=<>!&|^~?]/;

	function startsWith(str, pos, prefix) {
		return str.substr(pos, prefix.length) === prefix;
	}

	function highlight(code, lang) {
		var cfg = LANGS[lang] || LANGS._default;
		var out = "";
		var buf = ""; // pending plain text
		var i = 0;
		var n = code.length;
		var j, k, marker, close;

		function flush() {
			if (buf) {
				out += escapeHtml(buf);
				buf = "";
			}
		}
		function emit(cls, text) {
			flush();
			out += '<span class="' + cls + '">' + escapeHtml(text) + "</span>";
		}

		while (i < n) {
			// Line comment: consume to end of line.
			marker = null;
			for (j = 0; j < cfg.line.length; j++) {
				if (startsWith(code, i, cfg.line[j])) {
					marker = cfg.line[j];
					break;
				}
			}
			if (marker) {
				k = code.indexOf("\n", i);
				if (k === -1) {
					k = n;
				}
				emit("tok-comment", code.slice(i, k));
				i = k;
				continue;
			}

			// Block comment: consume through the closing marker.
			marker = null;
			for (j = 0; j < cfg.block.length; j++) {
				if (startsWith(code, i, cfg.block[j][0])) {
					marker = cfg.block[j][0];
					close = cfg.block[j][1];
					break;
				}
			}
			if (marker) {
				k = code.indexOf(close, i + marker.length);
				k = k === -1 ? n : k + close.length;
				emit("tok-comment", code.slice(i, k));
				i = k;
				continue;
			}

			// String: consume to the matching (unescaped) quote.
			if (cfg.quotes.indexOf(code[i]) !== -1) {
				var q = code[i];
				j = i + 1;
				while (j < n) {
					if (code[j] === "\\") {
						j += 2;
						continue;
					}
					if (code[j] === q || code[j] === "\n") {
						break;
					}
					j++;
				}
				// Include the closing quote if we landed on one.
				if (j < n && code[j] === q) {
					j++;
				}
				emit("tok-string", code.slice(i, j));
				i = j;
				continue;
			}

			// Symbol: single punctuation character.
			if (RE_SYMBOL.test(code[i])) {
				emit("tok-symbol", code[i]);
				i++;
				continue;
			}

			// Plain code.
			buf += code[i];
			i++;
		}

		flush();
		return out;
	}

	// ---------------------------------------------------------------------
	// 3. Block-level parsing (line based, blocks separated by blank lines).
	// ---------------------------------------------------------------------
	var RE_BLANK = /^\s*$/;
	var RE_HEADING = /^(#{1,6})\s+(.*)$/;
	var RE_HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
	var RE_FENCE = /^\s*```(.*)$/;
	var RE_QUOTE = /^\s*>\s?(.*)$/;
	var RE_UL = /^\s*[-*+]\s+(.*)$/;
	var RE_OL = /^\s*\d+\.\s+(.*)$/;
	var RE_HTML = /^\s*</;

	function parse(source) {
		var lines = source.split("\n");
		var out = [];
		var i = 0;
		var m;

		while (i < lines.length) {
			var line = lines[i];

			// Skip blank separators between blocks.
			if (RE_BLANK.test(line)) {
				i++;
				continue;
			}

			// Fenced code block: ```lang ... ```
			if ((m = line.match(RE_FENCE))) {
				var lang = m[1].trim();
				var code = [];
				i++;
				while (i < lines.length && !RE_FENCE.test(lines[i])) {
					code.push(lines[i]);
					i++;
				}
				i++; // consume the closing fence
				var cls = lang ? ' class="language-' + lang + '"' : "";
				out.push(
					"<pre><code" + cls + ">" +
						highlight(code.join("\n"), lang) +
						"</code></pre>"
				);
				continue;
			}

			// Raw HTML block: a run of lines starting with a tag. Passed
			// through verbatim (this is how <img>/<iframe> embeds survive).
			if (RE_HTML.test(line)) {
				var html = [];
				while (i < lines.length && !RE_BLANK.test(lines[i])) {
					html.push(lines[i]);
					i++;
				}
				out.push(html.join("\n"));
				continue;
			}

			// Heading: # .. ######
			if ((m = line.match(RE_HEADING))) {
				var level = m[1].length;
				out.push("<h" + level + ">" + inline(m[2]) + "</h" + level + ">");
				i++;
				continue;
			}

			// Horizontal rule: --- / *** / ___
			if (RE_HR.test(line)) {
				out.push("<hr>");
				i++;
				continue;
			}

			// Blockquote: consecutive > lines.
			if (RE_QUOTE.test(line)) {
				var quote = [];
				while (i < lines.length && (m = lines[i].match(RE_QUOTE))) {
					quote.push(m[1]);
					i++;
				}
				out.push("<blockquote><p>" + inline(quote.join(" ")) + "</p></blockquote>");
				continue;
			}

			// Unordered list.
			if (RE_UL.test(line)) {
				var ul = [];
				while (i < lines.length && (m = lines[i].match(RE_UL))) {
					ul.push("<li>" + inline(m[1]) + "</li>");
					i++;
				}
				out.push("<ul>" + ul.join("") + "</ul>");
				continue;
			}

			// Ordered list.
			if (RE_OL.test(line)) {
				var ol = [];
				while (i < lines.length && (m = lines[i].match(RE_OL))) {
					ol.push("<li>" + inline(m[1]) + "</li>");
					i++;
				}
				out.push("<ol>" + ol.join("") + "</ol>");
				continue;
			}

			// Paragraph: gather contiguous plain lines until a blank line or
			// the start of another block type.
			var para = [];
			while (
				i < lines.length &&
				!RE_BLANK.test(lines[i]) &&
				!RE_HTML.test(lines[i]) &&
				!RE_FENCE.test(lines[i]) &&
				!RE_HEADING.test(lines[i]) &&
				!RE_QUOTE.test(lines[i]) &&
				!RE_UL.test(lines[i]) &&
				!RE_OL.test(lines[i]) &&
				!RE_HR.test(lines[i])
			) {
				para.push(lines[i]);
				i++;
			}
			out.push("<p>" + inline(para.join(" ")) + "</p>");
		}

		// Put the inline elements back now that every block has been escaped
		// and wrapped. Doing it here (rather than inside inline()) means the
		// placeholders are restored wherever they landed.
		return restoreRaw(out.join("\n"));
	}

	// ---------------------------------------------------------------------
	// 4. Render.
	// ---------------------------------------------------------------------
	function render() {
		var body = document.getElementsByTagName("body")[0];
		var source = readSource(body);
		var article = document.createElement("article");
		article.innerHTML = parse(source);

		body.innerHTML = "";
		body.appendChild(article);
		injectThemeToggle();
	}

	injectStyles();
	// Apply the theme immediately (body already exists — this script is at the
	// bottom of it) so the page doesn't flash the wrong colors before render.
	// With no saved choice this uses the OS setting, so the page auto-detects.
	applyTheme(savedTheme() || (prefersDark() ? "dark" : "light"));

	// Keep following the OS setting live (e.g. it flips to dark at sunset),
	// but only until the reader makes an explicit choice via the toggle.
	if (window.matchMedia) {
		var mq = window.matchMedia("(prefers-color-scheme: dark)");
		var onSystemChange = function () {
			if (!savedTheme()) {
				applyTheme(mq.matches ? "dark" : "light");
				syncToggle();
			}
		};
		if (mq.addEventListener) {
			mq.addEventListener("change", onSystemChange);
		} else if (mq.addListener) {
			mq.addListener(onSystemChange); // older Safari / browsers
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", render);
	} else {
		render();
	}
})();
