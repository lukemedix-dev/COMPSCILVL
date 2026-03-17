// Firebase modular imports – switch to type="module" on the script tag
// firebase utility module handles initialization and exports
import {
    auth,
    db,
    doc,
    setDoc,
    getDoc,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut
} from './firebase.js';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  STATE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const state = {
    trackXp: { html: 0, js: 0 },
    level: 1,
    completed: [],
    currentTrack: null,
    currentModule: null,
    quiz: { q: 0, correct: 0, answered: 0, selected: null, questions: [] },
    isMini: false,                        // track whether current quiz is the mini challenge
    lastGateTime: 0,                     // for gate cooldown
    // each track keeps its own EXP storage (cumulative points earned)
    expStorage: { html: 0, js: 0 }
};

// session-storage helpers
function saveSession() {
    try {
        sessionStorage.setItem('appState', JSON.stringify(state));
    } catch (e) {
        console.warn('session save failed', e);
    }
}

function loadSession() {
    try {
        const raw = sessionStorage.getItem('appState');
        if (raw) {
            const obj = JSON.parse(raw);
            // shallow merge so we don't overwrite functions/etc
            Object.assign(state, obj);
        }
    } catch (e) {
        console.warn('session load failed', e);
    }
}

// load state from session storage right away (before any UI renders)
loadSession();

// ─────────────────────────────────────────────
//  SAVE / LOAD PROGRESS (Firestore)
// ─────────────────────────────────────────────
async function saveProgress() {
    const user = auth.currentUser;
    if (!user) {
        console.warn('No user logged in, cannot save progress');
        return;
    }
    try {
        // store the full state object so we can restore everything even after logout/refresh
        console.log('Saving progress for user:', user.uid);
        await setDoc(doc(db, 'progress', user.uid), {
            state,
            lastSaved: new Date().toISOString()
        });
        console.log('Progress saved successfully');
    } catch (e) {
        console.error('❌ Save failed:', e.message, e.code);
    }
    // keep a local copy as well for fast reloads
    saveSession();
}


async function loadProgress(uid) {
    try {
        console.log('Loading progress for user:', uid);
        const snap = await getDoc(doc(db, 'progress', uid));
        if (snap.exists()) {
            const data = snap.data();
            console.log('✓ Progress loaded from Firebase:', data);
            // merge entire saved state if available, otherwise fall back to old fields
            if (data.state) {
                Object.assign(state, data.state);
            } else {
                state.trackXp    = data.trackXp    || { html: 0, js: 0 };
                state.expStorage = data.expStorage || { html: 0, js: 0 };
                state.completed  = data.completed  || [];
            }
        } else {
            console.log('No saved progress found for this user (first login?)');
        }
    } catch (e) {
        console.error('❌ Load failed:', e.message, e.code);
    }
}

// authentication state changes are handled by firebase.js
onAuthStateChanged(auth, async user => {
    const emailEl = document.getElementById('user-email');
    const header = document.getElementById('main-header');
    if (user) {
        console.log("Logged in as", user.email);
        if (header) header.style.display = 'flex';
        document.getElementById('logout-btn').style.display = 'inline-block';
        if (emailEl) emailEl.textContent = user.email;
        await loadProgress(user.uid);
        // after loading from cloud, update session storage so it's in sync
        saveSession();
        updateHeaderStats();
        updateTrackProgress();
        checkSRankUnlock();
        showScreen('main');
        setTimeout(() => {
            const el = document.getElementById('track-section');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
        }, 50);
    } else {
        console.log("Not logged in");
        if (header) header.style.display = 'none';
        document.getElementById('logout-btn').style.display = 'none';
        if (emailEl) emailEl.textContent = '';
        // Reset state on logout
        state.trackXp    = { html: 0, js: 0 };
        state.expStorage = { html: 0, js: 0 };
        state.completed  = [];
        state.currentTrack  = null;
        state.currentModule = null;
        updateHeaderStats();
        updateTrackProgress();
        sessionStorage.removeItem('appState');
        showScreen('login');
    }
});

function login() {
    const email = document.getElementById('login-email').value;
    const pass  = document.getElementById('login-password').value;
    if (!email || !pass) { alert('Please enter email and password.'); return; }
    signInWithEmailAndPassword(auth, email, pass)
        .catch(err => alert(err.message));
}

function register() {
    const email = document.getElementById('login-email').value;
    const pass  = document.getElementById('login-password').value;
    if (!email || !pass) { alert('Please enter email and password.'); return; }
    createUserWithEmailAndPassword(auth, email, pass)
        .catch(err => alert(err.message));
}

async function logout() {
    console.log('Logout: Saving progress before signing out...');
    await saveProgress(); // ← wait for save to complete!
    await signOut(auth);
}


const RANKS = ['F','E','D','C','B','A','S'];
const RANK_COLORS = { F:'rank-f', E:'rank-e', D:'rank-d', C:'rank-c', B:'rank-b', A:'rank-a', S:'rank-s' };
const RANK_ROW = { F:'rank-f-row', E:'rank-e-row', D:'rank-d-row', C:'rank-c-row', B:'rank-b-row', A:'rank-a-row', S:'rank-s-row' };
const XP_PER_CORRECT = 10;
const RANK_XP_REQ = { F: 0, E: 150, D: 300, C: 500, B: 800, A: 1200, S: 0 };

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  TRACK DATA
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const tracks = {
    html: {
        title: '&#x1F5A5;&#xFE0F; HTML Track',
        subtitle: 'Build the structure of the web - from scratch to mastery.',
        modules: [
            {
                id: 'html1', rank: 'F', num: 1,
                name: 'Getting Started with HTML',
                desc: 'Learn what HTML is, how browsers read it, and write your very first webpage.',
                reviewer: `
<h3>What is HTML?</h3>
<p>HTML stands for <strong>HyperText Markup Language</strong>. It is the backbone of every webpage on the internet. When you visit any website, your browser downloads an HTML file and reads it to know what to display on screen. Think of HTML as the skeleton of a webpage &mdash; it gives everything its structure and meaning.</p>
<p>HTML uses <strong>tags</strong> &mdash; special keywords wrapped in angle brackets &mdash; to tell the browser how to display content. Tags usually come in pairs: an opening tag and a closing tag.</p>
<h3>Why Learn HTML First?</h3>
<p>HTML is always the first step in web development because every browser understands it natively. You do not need any tools or software to run HTML &mdash; just a text editor and a browser. It is the simplest and most direct way to put content on the web.</p>
<h3>Basic Document Structure</h3>
<p>Every HTML file must follow this exact structure. If any part is missing, the browser will still try to display it but may behave unexpectedly:</p>
<pre>&lt;!DOCTYPE html&gt;
&lt;html lang="en"&gt;
  &lt;head&gt;
    &lt;meta charset="UTF-8"&gt;
    &lt;title&gt;My First Page&lt;/title&gt;
  &lt;/head&gt;
  &lt;body&gt;
    &lt;h1&gt;Hello, World!&lt;/h1&gt;
    &lt;p&gt;This is my first webpage.&lt;/p&gt;
  &lt;/body&gt;
&lt;/html&gt;</pre>
<h3>What Each Part Does</h3>
<ul>
<li><code>&lt;!DOCTYPE html&gt;</code> &mdash; Not a tag, but a declaration. Tells the browser this is HTML5. Always put this on line 1.</li>
<li><code>&lt;html lang="en"&gt;</code> &mdash; The root element. Everything goes inside this. The lang attribute tells search engines and screen readers the page language.</li>
<li><code>&lt;head&gt;</code> &mdash; Contains information about the page NOT shown on screen, like the title and linked files.</li>
<li><code>&lt;meta charset="UTF-8"&gt;</code> &mdash; Tells the browser to use UTF-8 encoding so special characters and emojis display correctly.</li>
<li><code>&lt;title&gt;</code> &mdash; The text shown on the browser tab. Also what Google shows as the headline in search results.</li>
<li><code>&lt;body&gt;</code> &mdash; Everything the user actually sees on the page goes here.</li>
</ul>
<h3>Headings and Paragraphs</h3>
<p>HTML gives you six levels of headings. Use <code>&lt;h1&gt;</code> only once per page for the main topic. Use <code>&lt;h2&gt;</code> through <code>&lt;h6&gt;</code> for subheadings in order:</p>
<pre>&lt;h1&gt;Main Title&lt;/h1&gt;
&lt;h2&gt;Section Title&lt;/h2&gt;
&lt;h3&gt;Subsection&lt;/h3&gt;
&lt;p&gt;This is a paragraph of text.&lt;/p&gt;</pre>
<h3>Self-Closing Tags</h3>
<p>Some tags do not wrap around content so they do not need a closing tag:</p>
<pre>&lt;br&gt;    &lt;!-- Line break --&gt;
&lt;hr&gt;    &lt;!-- Horizontal line --&gt;
&lt;img&gt;   &lt;!-- Image --&gt;
&lt;input&gt; &lt;!-- Form input --&gt;
&lt;meta&gt;  &lt;!-- Meta information --&gt;</pre>
<div class="tip-box">&#x1F4A1; Always save your HTML files with the <strong>.html</strong> extension and open them in a browser. Right-click the file and choose Open With, then select your browser!</div>
`,
                questions: [
    { q: "What does HTML stand for?", o: ["HyperText Markup Language","HighText Machine Language","Hyperlink and Text Markup Language","HyperText Modern Language"], c: 0 },
    { q: "Which tag defines the visible content of an HTML page?", o: ["&lt;head&gt;","&lt;meta&gt;","&lt;body&gt;","&lt;html&gt;"], c: 2 },
    { q: "What is the correct HTML declaration for an HTML5 document?", o: ["&lt;html version=5&gt;","&lt;!DOCTYPE html&gt;","&lt;html5&gt;","&lt;!html&gt;"], c: 1 },
    { q: "Which tag is used for the largest heading?", o: ["&lt;h6&gt;","&lt;heading&gt;","&lt;h1&gt;","&lt;big&gt;"], c: 2 },
    { q: "Which of these is a self-closing tag?", o: ["&lt;p&gt;","&lt;div&gt;","&lt;br&gt;","&lt;span&gt;"], c: 2 },
    { q: "What does the &lt;title&gt; tag affect?", o: ["The main heading on the page","The browser tab text","The font size of headings","The page background color"], c: 1 },
    { q: "Where does the &lt;meta charset='UTF-8'&gt; tag go?", o: ["Inside &lt;body&gt;","Inside &lt;head&gt;","After &lt;/html&gt;","Inside &lt;title&gt;"], c: 1 },
    { q: "How many &lt;h1&gt; tags should a well-structured page ideally have?", o: ["As many as needed","Two","Only one","None, use &lt;h2&gt; instead"], c: 2 },
    { q: "What is the purpose of the lang attribute in &lt;html lang='en'&gt;?", o: ["Sets the text color","Tells the browser the page language","Makes text larger","Connects to a language library"], c: 1 },
    { q: "Which of the following is the correct nesting order?", o: ["&lt;body&gt; inside &lt;head&gt;","&lt;html&gt; inside &lt;body&gt;","&lt;head&gt; and &lt;body&gt; inside &lt;html&gt;","&lt;title&gt; inside &lt;body&gt;"], c: 2 },
    { q: "What does &lt;!DOCTYPE html&gt; tell the browser?", o: ["The file is a JavaScript file","This is an HTML5 document","The page encoding","The browser version needed"], c: 1 },
    { q: "Which section of HTML contains metadata about the page?", o: ["&lt;body&gt;","&lt;head&gt;","&lt;meta&gt;","&lt;info&gt;"], c: 1 },
    { q: "What file extension should HTML files have?", o: [".htm or .html",".html5",".doc",".web"], c: 0 },
    { q: "Why is UTF-8 encoding important?", o: ["It makes the website faster","It allows special characters and emojis to display correctly","It improves SEO","It reduces file size"], c: 1 },
    { q: "What is the purpose of the &lt;head&gt; section?", o: ["To display the header of the page","To hold metadata, title, and linked resources","To contain all visible content","To define navigation links"], c: 1 },
    { q: "Which heading tag is the smallest?", o: ["&lt;h1&gt;","&lt;h3&gt;","&lt;h6&gt;","&lt;heading&gt;"], c: 2 },
    { q: "Can you place the &lt;title&gt; tag inside the &lt;body&gt;?", o: ["Yes, anywhere works","No, it must be in &lt;head&gt;","Only in the first line of body","It doesn't matter"], c: 1 },
    { q: "What does a browser do if &lt;!DOCTYPE html&gt; is missing?", o: ["Shows an error","Uses 'quirks mode' and may behave unexpectedly","Ignores the page entirely","Automatically adds it"], c: 1 },
    { q: "Which attribute specifies the language of the document?", o: ["language","locale","lang","dialect"], c: 2 },
    { q: "Is &lt;meta charset='UTF-8'&gt; optional?", o: ["Yes, not necessary","No, it's required for proper character display","Only for international sites","Only for mobile devices"], c: 1 },
    { q: "What is the role of the &lt;html&gt; root element?", o: ["Just a container, no real purpose","Tells browser this is HTML and wraps all content","Creates the page title","Defines page styling"], c: 1 },
    // fill-in-the-blank question derived from reviewer
    { type: 'fill', q: "HTML stands for ___", correct: "HyperText Markup Language" },
    // code debugging challenge: user must fix the missing closing tag
    {
        type: 'code',
        q: "The following HTML snippet is missing something. Edit the code so it is valid:",
        template: "<h1>Welcome to HTML", 
        correctCode: "<h1>Welcome to HTML</h1>"
    },
    {
        type: 'code',
        q: "This JavaScript code has a syntax error. Correct it so the console.log runs:",
        template: "console.log('Hello world'", 
        correctCode: "console.log('Hello world');"
    }
]
            },
            {
                id: 'html2', rank: 'E', num: 2,
                name: 'Formatting Text and Organizing Data',
                desc: 'Style text with HTML tags and organize information using lists and tables.',
                reviewer: `
<h3>Text Formatting Tags</h3>
<p>HTML has many tags for giving text meaning and visual style. The key difference between some of these is <strong>semantic meaning</strong> &mdash; some tags tell the browser the text is important, not just visually different:</p>
<ul>
<li><code>&lt;strong&gt;</code> &mdash; Bold and semantically important. Screen readers will emphasize this.</li>
<li><code>&lt;b&gt;</code> &mdash; Bold visually only. No extra meaning attached.</li>
<li><code>&lt;em&gt;</code> &mdash; Italic with emphasis. Screen readers stress this word.</li>
<li><code>&lt;i&gt;</code> &mdash; Italic visually only. Used for technical terms or foreign words.</li>
<li><code>&lt;u&gt;</code> &mdash; Underlined text. Be careful &mdash; users might confuse it with a link.</li>
<li><code>&lt;mark&gt;</code> &mdash; Highlighted text with a yellow background by default.</li>
<li><code>&lt;small&gt;</code> &mdash; Smaller text, often used for disclaimers or fine print.</li>
<li><code>&lt;del&gt;</code> &mdash; Strikethrough text. Shows something was removed or is no longer valid.</li>
<li><code>&lt;sup&gt;</code> &mdash; Superscript. Example: x&lt;sup&gt;2&lt;/sup&gt; displays as x squared.</li>
<li><code>&lt;sub&gt;</code> &mdash; Subscript. Example: H&lt;sub&gt;2&lt;/sub&gt;O displays as water formula.</li>
</ul>
<h3>The Difference Between &lt;strong&gt; and &lt;b&gt;</h3>
<p>They both look bold in the browser but mean different things. Use <code>&lt;strong&gt;</code> when the text is genuinely important. Use <code>&lt;b&gt;</code> only when you want bold styling with no special meaning, like a product name or keyword.</p>
<h3>Lists</h3>
<p>Lists are one of the most used structures in HTML. There are three types:</p>
<pre>&lt;!-- Unordered list (bullet points) --&gt;
&lt;ul&gt;
  &lt;li&gt;HTML&lt;/li&gt;
  &lt;li&gt;CSS&lt;/li&gt;
  &lt;li&gt;JavaScript&lt;/li&gt;
&lt;/ul&gt;

&lt;!-- Ordered list (numbered) --&gt;
&lt;ol&gt;
  &lt;li&gt;Step One: Open editor&lt;/li&gt;
  &lt;li&gt;Step Two: Write HTML&lt;/li&gt;
  &lt;li&gt;Step Three: Open in browser&lt;/li&gt;
&lt;/ol&gt;

&lt;!-- Description list (term + definition) --&gt;
&lt;dl&gt;
  &lt;dt&gt;HTML&lt;/dt&gt;
  &lt;dd&gt;The structure of webpages&lt;/dd&gt;
  &lt;dt&gt;CSS&lt;/dt&gt;
  &lt;dd&gt;The style of webpages&lt;/dd&gt;
&lt;/dl&gt;</pre>
<h3>Tables</h3>
<p>Tables are used to display data in rows and columns, like a spreadsheet. Never use tables just for layout &mdash; use them only for actual tabular data:</p>
<pre>&lt;table&gt;
  &lt;thead&gt;
    &lt;tr&gt;
      &lt;th&gt;Name&lt;/th&gt;
      &lt;th&gt;Score&lt;/th&gt;
      &lt;th&gt;Grade&lt;/th&gt;
    &lt;/tr&gt;
  &lt;/thead&gt;
  &lt;tbody&gt;
    &lt;tr&gt;
      &lt;td&gt;Alice&lt;/td&gt;
      &lt;td&gt;95&lt;/td&gt;
      &lt;td&gt;A&lt;/td&gt;
    &lt;/tr&gt;
    &lt;tr&gt;
      &lt;td&gt;Bob&lt;/td&gt;
      &lt;td&gt;78&lt;/td&gt;
      &lt;td&gt;B&lt;/td&gt;
    &lt;/tr&gt;
  &lt;/tbody&gt;
&lt;/table&gt;</pre>
<h3>Table Tags Explained</h3>
<ul>
<li><code>&lt;table&gt;</code> &mdash; The outer container for the entire table</li>
<li><code>&lt;thead&gt;</code> &mdash; Groups the header row</li>
<li><code>&lt;tbody&gt;</code> &mdash; Groups the data rows</li>
<li><code>&lt;tr&gt;</code> &mdash; Table row</li>
<li><code>&lt;th&gt;</code> &mdash; Table header cell, bold and centered by default</li>
<li><code>&lt;td&gt;</code> &mdash; Table data cell</li>
<li><code>colspan="2"</code> &mdash; Makes a cell span 2 columns</li>
<li><code>rowspan="2"</code> &mdash; Makes a cell span 2 rows</li>
</ul>
<div class="tip-box">&#x1F4A1; Use <code>&lt;thead&gt;</code> and <code>&lt;tbody&gt;</code> even for simple tables &mdash; it helps with CSS styling and makes your table accessible to screen readers!</div>
`,
                questions: [
    { q: "Which tag makes text bold AND semantically important?", o: ["&lt;b&gt;","&lt;bold&gt;","&lt;strong&gt;","&lt;i&gt;"], c: 2 },
    { q: "Which tag creates an ordered (numbered) list?", o: ["&lt;ul&gt;","&lt;ol&gt;","&lt;list&gt;","&lt;li&gt;"], c: 1 },
    { q: "What tag defines a table row?", o: ["&lt;td&gt;","&lt;th&gt;","&lt;tr&gt;","&lt;table&gt;"], c: 2 },
    { q: "Which tag is used for each item in a list?", o: ["&lt;item&gt;","&lt;bullet&gt;","&lt;li&gt;","&lt;list&gt;"], c: 2 },
    { q: "Which tag creates highlighted text in HTML5?", o: ["&lt;highlight&gt;","&lt;mark&gt;","&lt;em&gt;","&lt;color&gt;"], c: 1 },
    { q: "What is the difference between &lt;strong&gt; and &lt;b&gt;?", o: ["No difference at all","&lt;strong&gt; has semantic importance, &lt;b&gt; is visual only","&lt;b&gt; is newer than &lt;strong&gt;","&lt;strong&gt; only works in forms"], c: 1 },
    { q: "Which tag is used for header cells in a table?", o: ["&lt;td&gt;","&lt;header&gt;","&lt;th&gt;","&lt;tc&gt;"], c: 2 },
    { q: "What does the colspan attribute do in a table?", o: ["Sets the column color","Makes a cell span multiple columns","Adds a border","Sets column width"], c: 1 },
    { q: "Which list type is best for step-by-step instructions?", o: ["&lt;ul&gt;","&lt;dl&gt;","&lt;ol&gt;","&lt;list&gt;"], c: 2 },
    { q: "What does &lt;del&gt; visually render as?", o: ["Bold text","Underlined text","Strikethrough text","Italic text"], c: 2 },
    { q: "What is the &lt;em&gt; tag used for?", o: ["Emphasis with semantic meaning","Creating empty space","Making text larger","Embedding media"], c: 0 },
    { q: "Which tag is used for inline styling without semantic meaning?", o: ["&lt;span&gt;","&lt;div&gt;","&lt;style&gt;","&lt;p&gt;"], c: 0 },
    { q: "What does the &lt;sub&gt; tag do?", o: ["Creates a subscription form","Displays text as subscript","Submits data","Creates a sidebar"], c: 1 },
    { q: "Which structure groups description terms and definitions?", o: ["&lt;ul&gt;","&lt;ol&gt;","&lt;dl&gt;","&lt;list&gt;"], c: 2 },
    { q: "What is the &lt;dt&gt; tag used for?", o: ["Data table","Definition term","Data text","Default table"], c: 1 },
    { q: "Which tag wraps the main data rows in a table?", o: ["&lt;thead&gt;","&lt;tbody&gt;","&lt;tfoot&gt;","&lt;tr&gt;"], c: 1 },
    { q: "When should you use semantic tags like &lt;strong&gt; instead of &lt;b&gt;?", o: ["Never, they're the same","When the content is truly important","Only in titles","When styling is needed"], c: 1 },
    { q: "What visual effect does the &lt;mark&gt; tag create?", o: ["Bold text","Underlined text","Highlighted text","Italic text"], c: 2 },
    { q: "Which tag creates a longer text emphasis with meaning?", o: ["&lt;i&gt;","&lt;em&gt;","&lt;b&gt;","&lt;mark&gt;"], c: 1 },
    { q: "What does &lt;small&gt; represent semantically?", o: ["Smaller font size only","Fine print or disclaimers","Less important text","Comments"], c: 1 },
    { q: "How do you create nested lists in HTML?", o: ["Use multiple &lt;ol&gt; tags","Put a list inside another list item","Use &lt;sublist&gt; tag","Lists cannot be nested"], c: 1 }
]
            },
            {
                id: 'html3', rank: 'D', num: 3,
                name: 'Exploring Visual and Interactive Elements',
                desc: 'Add images, links, and forms to make your pages interactive and visual.',
                reviewer: `
<h3>Links (Anchor Tags)</h3>
<p>The <code>&lt;a&gt;</code> tag creates hyperlinks. The <code>href</code> attribute tells the browser where to go when the link is clicked. Links can point to external sites, other pages on your site, or even specific sections on the same page:</p>
<pre>&lt;a href="https://google.com"&gt;Visit Google&lt;/a&gt;
&lt;a href="about.html"&gt;About Page&lt;/a&gt;
&lt;a href="#section1"&gt;Jump to Section 1&lt;/a&gt;
&lt;a href="https://google.com" target="_blank"&gt;Open in new tab&lt;/a&gt;
&lt;a href="mailto:me@email.com"&gt;Send Email&lt;/a&gt;</pre>
<h3>Important Link Attributes</h3>
<ul>
<li><code>href</code> &mdash; The destination URL or path</li>
<li><code>target="_blank"</code> &mdash; Opens the link in a new browser tab</li>
<li><code>rel="noopener"</code> &mdash; Security best practice when using target="_blank"</li>
<li><code>download</code> &mdash; Makes the browser download the file instead of opening it</li>
</ul>
<h3>Images</h3>
<p>The <code>&lt;img&gt;</code> tag embeds images. It is self-closing. The <code>src</code> is the path to the image and <code>alt</code> is shown if the image fails to load or is read by screen readers:</p>
<pre>&lt;img src="photo.jpg" alt="A beautiful sunset photo" width="300" height="200"&gt;
&lt;img src="https://example.com/logo.png" alt="Company logo"&gt;</pre>
<h3>HTML Forms</h3>
<p>Forms are how users send data. The <code>action</code> attribute says where the data goes and <code>method</code> says how it is sent:</p>
<pre>&lt;form action="/submit" method="post"&gt;
  &lt;label for="name"&gt;Your Name:&lt;/label&gt;
  &lt;input type="text" id="name" name="name" placeholder="Enter name"&gt;

  &lt;label for="email"&gt;Email:&lt;/label&gt;
  &lt;input type="email" id="email" name="email"&gt;

  &lt;input type="password" placeholder="Password"&gt;

  &lt;input type="checkbox" id="agree" name="agree"&gt;
  &lt;label for="agree"&gt;I agree to the terms&lt;/label&gt;

  &lt;input type="radio" name="gender" value="male"&gt; Male
  &lt;input type="radio" name="gender" value="female"&gt; Female

  &lt;button type="submit"&gt;Submit&lt;/button&gt;
&lt;/form&gt;</pre>
<h3>GET vs POST</h3>
<p><strong>GET</strong> &mdash; Data is sent in the URL (visible in the address bar). Use for searches and non-sensitive data.<br>
<strong>POST</strong> &mdash; Data is sent in the request body hidden from the URL. Use for passwords and personal info.</p>
<h3>Common Input Types</h3>
<ul>
<li><code>text</code> &mdash; Single-line text</li>
<li><code>email</code> &mdash; Email with built-in validation</li>
<li><code>password</code> &mdash; Hides typed characters</li>
<li><code>checkbox</code> &mdash; A tick box, can select multiple</li>
<li><code>radio</code> &mdash; Select only one from a group with the same name</li>
<li><code>number</code> &mdash; Number input with arrows</li>
<li><code>submit</code> &mdash; Submits the form</li>
<li><code>reset</code> &mdash; Clears all form fields</li>
</ul>
<div class="tip-box">&#x1F4A1; Always pair <code>&lt;label&gt;</code> with inputs using matching <code>for</code> and <code>id</code> attributes. This makes the label clickable and greatly improves accessibility!</div>
`,
                questions: [
    { q: "Which attribute of the &lt;img&gt; tag provides alternative text?", o: ["src","title","alt","name"], c: 2 },
    { q: "What does the href attribute in &lt;a&gt; specify?", o: ["The link's color","The link's destination","The link's size","The link's font"], c: 1 },
    { q: "Which input type hides the text being typed?", o: ["hidden","text","secret","password"], c: 3 },
    { q: "What attribute makes a form send data via POST?", o: ["action","type","method","send"], c: 2 },
    { q: "Which tag is used to create a clickable button inside a form?", o: ["&lt;click&gt;","&lt;input type='button'&gt;","&lt;button&gt;","Both B and C"], c: 3 },
    { q: "What does target='_blank' do on an anchor tag?", o: ["Opens link in same tab","Opens link in a new tab","Downloads the file","Disables the link"], c: 1 },
    { q: "What is the difference between GET and POST methods in a form?", o: ["No difference","GET sends data in URL, POST hides it in request body","POST is faster than GET","GET is only for images"], c: 1 },
    { q: "Which input type allows selecting only ONE option from a group?", o: ["checkbox","select","radio","option"], c: 2 },
    { q: "What attribute on &lt;input&gt; shows hint text before the user types?", o: ["hint","default","placeholder","value"], c: 2 },
    { q: "Which link href value creates a link to a section on the same page?", o: ["href='page.html'","href='https://site.com'","href='#sectionId'","href='./folder'"], c: 2 },
    { q: "What is the purpose of the alt attribute on images?", o: ["Adds a border to the image","Provides text when image fails or for screen readers","Sets the image size","Changes image color"], c: 1 },
    { q: "Can the &lt;img&gt; tag have closing tag tags?", o: ["Yes, always","No, it's self-closing","Only in HTML5","Sometimes"], c: 1 },
    { q: "What does the src attribute specify in an &lt;img&gt; tag?", o: ["The image styling","The path to the image file","The image size","The image caption"], c: 1 },
    { q: "Which attribute opens a link in a new window?", o: ["target='new'","new='true'","target='_blank'","window='new'"], c: 2 },
    { q: "How do you create a link to send an email?", o: ["&lt;a href='email:user@site.com'&gt;","&lt;a href='mailto:user@site.com'&gt;","&lt;a email='user@site.com'&gt;","&lt;email href='user@site.com'&gt;"], c: 1 },
    { q: "What does the download attribute do on a link?", o: ["Disables the link","Makes the browser download the file","Adds a loading indicator","Requires login"], c: 1 },
    { q: "Which input type is best for email addresses?", o: ["&lt;input type='text'&gt;","&lt;input type='email'&gt;","&lt;input type='string'&gt;","&lt;input type='mail'&gt;"], c: 1 },
    { q: "What does the &lt;label&gt; tag do?", o: ["Creates a company label","Associates text with a form input","Adds a watermark","Creates a loading label"], c: 1 },
    { q: "Why should form inputs have associated labels?", o: ["It's just for styling","It improves accessibility and makes labels clickable","It's required by law","It speeds up forms"], c: 1 },
    { q: "What attribute links a label to an input field?", o: ["name","value","id and for","class"], c: 2 },
    { q: "Which method is more secure for passwords in forms?", o: ["GET","POST","Both are equal","Neither is secure"], c: 1 }
]
            },
            {
                id: 'html4', rank: 'C', num: 4,
                name: 'Enhancing Web Presentation',
                desc: 'Use semantic tags, divs, spans, and connect CSS to structure and style your pages.',
                reviewer: `
<h3>Semantic HTML</h3>
<p>Semantic tags give <strong>meaning</strong> to your content &mdash; not just structure. They tell the browser, search engines, and screen readers exactly what role each section plays on the page. Using semantic HTML makes your site more accessible and helps it rank better on Google:</p>
<pre>&lt;header&gt;Site logo and navigation&lt;/header&gt;
&lt;nav&gt;Navigation links go here&lt;/nav&gt;
&lt;main&gt;
  &lt;section&gt;A grouped topic section&lt;/section&gt;
  &lt;article&gt;A self-contained piece like a blog post&lt;/article&gt;
  &lt;aside&gt;Sidebar, related links, ads&lt;/aside&gt;
&lt;/main&gt;
&lt;footer&gt;Copyright, contact info&lt;/footer&gt;</pre>
<h3>When to Use Which Semantic Tag</h3>
<ul>
<li><code>&lt;header&gt;</code> &mdash; Top of the page or section. Contains logo, nav, hero content.</li>
<li><code>&lt;nav&gt;</code> &mdash; Contains navigation links only.</li>
<li><code>&lt;main&gt;</code> &mdash; The primary content of the page. Use only once per page.</li>
<li><code>&lt;section&gt;</code> &mdash; A themed grouping of content with its own heading.</li>
<li><code>&lt;article&gt;</code> &mdash; Content that makes sense on its own like a blog post or news story.</li>
<li><code>&lt;aside&gt;</code> &mdash; Content tangentially related to the main content like a sidebar.</li>
<li><code>&lt;footer&gt;</code> &mdash; Bottom of the page. Copyright, links, contact info.</li>
</ul>
<h3>Div and Span</h3>
<p><code>&lt;div&gt;</code> and <code>&lt;span&gt;</code> are generic containers with NO semantic meaning. Use them only when no semantic tag fits:</p>
<pre>&lt;!-- div is BLOCK-LEVEL: takes full width, starts new line --&gt;
&lt;div class="card"&gt;
  &lt;h2&gt;Card Title&lt;/h2&gt;
  &lt;p&gt;Card content here&lt;/p&gt;
&lt;/div&gt;

&lt;!-- span is INLINE: wraps only around its content --&gt;
&lt;p&gt;My favorite color is &lt;span style="color:red"&gt;red&lt;/span&gt;.&lt;/p&gt;</pre>
<h3>Three Ways to Add CSS</h3>
<p>You can style HTML in three ways, from least to most recommended:</p>
<pre>&lt;!-- 1. Inline: directly on the element, hard to maintain --&gt;
&lt;p style="color:blue; font-size:18px"&gt;Blue text&lt;/p&gt;

&lt;!-- 2. Internal: inside a style tag in head, okay for small pages --&gt;
&lt;style&gt;
  p { color: blue; }
&lt;/style&gt;

&lt;!-- 3. External: linked stylesheet, best practice --&gt;
&lt;link rel="stylesheet" href="styles.css"&gt;</pre>
<h3>Classes and IDs</h3>
<p>Classes and IDs let you target specific elements with CSS and JavaScript:</p>
<pre>&lt;!-- class: reusable, can be used on many elements --&gt;
&lt;div class="card highlight"&gt;I have two classes&lt;/div&gt;
&lt;p class="card"&gt;I also have the card class&lt;/p&gt;

&lt;!-- id: unique, used only ONCE per page --&gt;
&lt;div id="main-hero"&gt;Unique hero section&lt;/div&gt;</pre>
<div class="tip-box">&#x1F4A1; Use <strong>classes</strong> for styles you want to reuse and <strong>IDs</strong> for unique elements. In CSS, classes use a dot (<code>.card</code>) and IDs use a hash (<code>#main-hero</code>).</div>
`,
                questions: [
    { q: "Which tag represents the main navigation area?", o: ["&lt;menu&gt;","&lt;nav&gt;","&lt;header&gt;","&lt;links&gt;"], c: 1 },
    { q: "What is the difference between &lt;div&gt; and &lt;span&gt;?", o: ["No difference","div is inline, span is block","div is block-level, span is inline","div is for CSS only"], c: 2 },
    { q: "Which is the BEST practice for linking an external CSS file?", o: ["&lt;style src='file.css'&gt;","&lt;css href='file.css'&gt;","&lt;link rel='stylesheet' href='file.css'&gt;","&lt;import css='file.css'&gt;"], c: 2 },
    { q: "Which attribute is meant to be unique on the page?", o: ["class","style","id","name"], c: 2 },
    { q: "Which tag marks the footer of a document?", o: ["&lt;bottom&gt;","&lt;end&gt;","&lt;section&gt;","&lt;footer&gt;"], c: 3 },
    { q: "What is the purpose of semantic HTML?", o: ["To make pages load faster","To give meaning to content for browsers and screen readers","To replace CSS styling","To add JavaScript behavior"], c: 1 },
    { q: "How many times should &lt;main&gt; appear on a single page?", o: ["As many as needed","Twice","Only once","Never, use &lt;div&gt; instead"], c: 2 },
    { q: "What is the correct CSS selector for a class named 'card'?", o: ["#card","card","*card",".card"], c: 3 },
    { q: "Which tag is best for a self-contained blog post?", o: ["&lt;section&gt;","&lt;div&gt;","&lt;article&gt;","&lt;aside&gt;"], c: 2 },
    { q: "Can one HTML element have multiple classes?", o: ["No, only one class is allowed","Yes, separated by spaces","Yes, but only two maximum","Only if using JavaScript"], c: 1 },
    { q: "Which tag represents a top-level header?", o: ["&lt;top&gt;","&lt;header&gt;","&lt;head&gt;","&lt;h1&gt;"], c: 1 },
    { q: "What is the purpose of the &lt;nav&gt; tag?", o: ["Creates a navigation menu","Defines naval elements","Marks the start of text","Adds scrolling behavior"], c: 0 },
    { q: "Should a &lt;div&gt; be used for navigation?", o: ["Yes, always","No, use &lt;nav&gt;","Only for nested navigation","Both work the same"], c: 1 },
    { q: "What is the difference between &lt;section&gt; and &lt;article&gt;?", o: ["No difference","Article is self-contained, section groups related content","Section is larger","They can't be nested"], c: 1 },
    { q: "When should you use an &lt;aside&gt; tag?", o: ["For main content","For sidebar content or tangentially related info","For footer information","For navigation only"], c: 1 },
    { q: "What does inline styling mean?", o: ["Styling applied inside external CSS","Style attribute directly on an HTML element","Importing CSS in the head","Using CSS classes"], c: 1 },
    { q: "Is it a good practice to use inline styles?", o: ["Yes, it's the best way","No, it's hard to maintain","Only for emergency fixes","Never, use external CSS"], c: 2 },
    { q: "How do you add a comment in HTML?", o: ["// Comment","/* Comment */","&lt;!-- Comment --&gt;","# Comment"], c: 2 },
    { q: "What is the difference between id and class?", o: ["No difference","id is unique, class can be reused","class is unique, id can be reused","id is for CSS, class is for JavaScript"], c: 1 },
    { q: "Can a page have multiple &lt;header&gt; tags?", o: ["No, only one per page","Yes, can be used for sections too","Only on the homepage","Never allowed"], c: 1 },
    { q: "What does the &lt;section&gt; tag require?", o: ["A heading inside","An id attribute","Nothing required","JavaScript handler"], c: 0 },
    { q: "Which semantic tag should wrap your main page content?", o: ["&lt;section&gt;","&lt;main&gt;","&lt;body&gt;","&lt;container&gt;"], c: 1 }
]
            },
            {
                id: 'html5', rank: 'B', num: 5,
                name: 'Building Optimized and Accessible Web Content',
                desc: 'Write accessible, SEO-friendly HTML with proper meta tags and ARIA roles.',
                reviewer: `
<h3>What is SEO?</h3>
<p>SEO stands for <strong>Search Engine Optimization</strong>. It means writing HTML in a way that helps Google and other search engines understand your page and rank it higher in search results. Good HTML structure is one of the most important factors in SEO &mdash; a well-structured page with proper headings, meta tags, and semantic elements will always rank better than a poorly structured one.</p>
<h3>Meta Tags for SEO</h3>
<p>Meta tags live in the <code>&lt;head&gt;</code> section and are invisible to users but very important for search engines and social media sharing:</p>
<pre>&lt;head&gt;
  &lt;meta charset="UTF-8"&gt;
  &lt;meta name="viewport" content="width=device-width, initial-scale=1.0"&gt;
  &lt;meta name="description" content="Learn HTML from scratch in this beginner guide."&gt;
  &lt;meta name="keywords" content="HTML, web development, tutorial"&gt;
  &lt;meta name="author" content="Your Name"&gt;

  &lt;!-- Open Graph: controls how page looks when shared on social media --&gt;
  &lt;meta property="og:title" content="Learn HTML"&gt;
  &lt;meta property="og:description" content="A beginner HTML guide"&gt;
  &lt;meta property="og:image" content="thumbnail.jpg"&gt;

  &lt;title&gt;Learn HTML | Beginner Guide&lt;/title&gt;
&lt;/head&gt;</pre>
<h3>Accessibility (a11y)</h3>
<p>Accessibility means making your website usable for EVERYONE, including people who are blind, deaf, or have motor disabilities. In many countries, websites are legally required to be accessible:</p>
<ul>
<li>Always use <code>alt</code> attributes on images &mdash; screen readers read this aloud</li>
<li>Always pair <code>&lt;label&gt;</code> with form inputs</li>
<li>Use semantic HTML tags since they have built-in accessibility</li>
<li>Use headings in logical order, never skip levels like going from h1 to h3</li>
<li>Ensure sufficient color contrast between text and background</li>
<li>Make sure all interactive elements are keyboard-accessible using Tab</li>
</ul>
<h3>ARIA Roles</h3>
<p>ARIA (Accessible Rich Internet Applications) adds extra information to elements that screen readers can use. Use ARIA only when a semantic HTML tag cannot do the job on its own:</p>
<pre>&lt;button aria-label="Close menu"&gt;X&lt;/button&gt;
&lt;div role="alert"&gt;Form submitted successfully!&lt;/div&gt;
&lt;nav aria-label="Main navigation"&gt;...&lt;/nav&gt;
&lt;div role="progressbar" aria-valuenow="70" aria-valuemin="0" aria-valuemax="100"&gt;&lt;/div&gt;</pre>
<h3>HTML Media Elements</h3>
<p>HTML5 introduced native audio and video support without needing any plugins:</p>
<pre>&lt;video controls width="400" poster="thumbnail.jpg"&gt;
  &lt;source src="video.mp4" type="video/mp4"&gt;
  &lt;source src="video.webm" type="video/webm"&gt;
  Your browser does not support video.
&lt;/video&gt;

&lt;audio controls&gt;
  &lt;source src="audio.mp3" type="audio/mpeg"&gt;
  &lt;source src="audio.ogg" type="audio/ogg"&gt;
&lt;/audio&gt;</pre>
<div class="tip-box">&#x1F4A1; The viewport meta tag is absolutely essential for mobile responsive design &mdash; without it, your page will appear zoomed out on phones and tablets!</div>
`,
                questions: [
    { q: "What does the 'alt' attribute on &lt;img&gt; primarily help with?", o: ["Styling the image","SEO ranking only","Accessibility for screen readers","Image loading speed"], c: 2 },
    { q: "What does ARIA stand for?", o: ["Advanced Rich Interface App","Accessible Rich Internet Applications","Automated Rendering Internet Aid","Active Responsive Interface API"], c: 1 },
    { q: "Which meta tag is critical for mobile-responsive design?", o: ["charset","keywords","viewport","author"], c: 2 },
    { q: "Which HTML element should you use for background music?", o: ["&lt;music&gt;","&lt;sound&gt;","&lt;audio&gt;","&lt;media&gt;"], c: 2 },
    { q: "What is the correct order of heading tags for accessibility?", o: ["Any order is fine","h6 before h1","h1 then h2 then h3 in order","Always use h2 first"], c: 2 },
    { q: "What does SEO stand for?", o: ["Site Encoding Optimization","Search Engine Optimization","Structured Element Output","Semantic Element Order"], c: 1 },
    { q: "What is the purpose of the Open Graph meta tags?", o: ["They speed up the page","They control how the page looks when shared on social media","They add animations","They replace the title tag"], c: 1 },
    { q: "When should you use ARIA roles?", o: ["Always on every element","Only on images","When semantic HTML alone cannot convey the role","Never, CSS handles this"], c: 2 },
    { q: "What does the poster attribute on &lt;video&gt; do?", o: ["Adds a watermark","Sets the video speed","Shows a thumbnail image before the video plays","Adds subtitles"], c: 2 },
    { q: "Which of these is a legal requirement in many countries regarding websites?", o: ["Using only one font","Having a dark mode","Web accessibility for disabled users","Using HTTPS only"], c: 2 },
    { q: "What meta tag should describe your webpage in 160 characters?", o: ["&lt;meta keywords&gt;","&lt;meta description&gt;","&lt;meta content&gt;","&lt;meta summary&gt;"], c: 1 },
    { q: "Does good HTML structure help with SEO?", o: ["No, only JavaScript matters","Yes, it's one of the most important SEO factors","Not really, keywords are all that matters","Only if you use tables"], c: 1 },
    { q: "What does &lt;video&gt; controls attribute do?", o: ["Adds styling","Shows play, pause, and volume buttons","Activates fullscreen mode","Enables subtitles"], c: 1 },
    { q: "Which attribute makes an image lazy-load?", o: ["async","defer","lazy","load='lazy'"], c: 2 },
    { q: "What is the purpose of the &lt;picture&gt; element?", o: ["Shows pictures in a gallery","Provides multiple images for different screen sizes","Creates an image editor","Adds photo filters"], c: 1 },
    { q: "How many heading levels can you have in HTML?", o: ["4","6","10","Unlimited"], c: 1 },
    { q: "What is the first meta tag that should be in the &lt;head&gt;?", o: ["&lt;title&gt;","&lt;meta charset&gt;","&lt;meta viewport&gt;","&lt;link&gt;"], c: 1 },
    { q: "Which attribute improves accessibility of buttons?", o: ["label","aria-label","title","hint"], c: 1 },
    { q: "Can you nest headings in HTML?", o: ["No, headings cannot be nested","Yes, but follow hierarchy","Only h1 can contain others","Only with CSS classes"], c: 1 },
    { q: "What is the &lt;time&gt; element used for?", o: ["Measuring page load time","Displaying time on a clock","Marking dates and times semantically","Setting timeouts"], c: 2 },
    { q: "Does HTML7 exist?", o: ["Yes, it was released in 2020","No, we're on HTML5 with continuous updates","It's coming next year","HTML goes up to 10"], c: 1 }
]
            },
            {
                id: 'html6', rank: 'A', num: 6,
                name: 'Exploring HTML Beyond Basics',
                desc: 'Explore iframes, data attributes, HTML5 APIs, and advanced form features.',
                reviewer: `
<h3>iFrames</h3>
<p>An <code>&lt;iframe&gt;</code> (inline frame) embeds another webpage inside your page. This is how YouTube videos, Google Maps, and external widgets are embedded into sites. The <code>title</code> attribute is required for accessibility:</p>
<pre>&lt;iframe
  src="https://www.youtube.com/embed/VIDEO_ID"
  width="560"
  height="315"
  title="YouTube video"
  allowfullscreen&gt;
&lt;/iframe&gt;

&lt;!-- Google Maps embed --&gt;
&lt;iframe
  src="https://maps.google.com/maps?q=Manila&amp;output=embed"
  width="600"
  height="400"
  title="Map of Manila"&gt;
&lt;/iframe&gt;</pre>
<h3>Data Attributes</h3>
<p>Custom <code>data-*</code> attributes let you store extra information directly on HTML elements. This is extremely useful for JavaScript to read without creating extra variables. You can name them anything after <code>data-</code>:</p>
<pre>&lt;div data-user-id="42" data-role="admin" data-status="active"&gt;John&lt;/div&gt;
&lt;button data-product-id="101" data-price="299"&gt;Add to Cart&lt;/button&gt;</pre>
<p>Access them in JavaScript using the <code>dataset</code> property. Note that hyphenated names become camelCase:</p>
<pre>const div = document.querySelector('div');
console.log(div.dataset.userId);   // "42"
console.log(div.dataset.role);     // "admin"
console.log(div.dataset.status);   // "active"</pre>
<h3>Advanced Form Features</h3>
<p>HTML5 added many powerful new input types that provide built-in validation and better user experience especially on mobile devices:</p>
<pre>&lt;input type="date"&gt;           &lt;!-- Date picker --&gt;
&lt;input type="time"&gt;           &lt;!-- Time picker --&gt;
&lt;input type="range" min="0" max="100" step="5"&gt;  &lt;!-- Slider --&gt;
&lt;input type="color"&gt;          &lt;!-- Color picker --&gt;
&lt;input type="number" min="1" max="10"&gt;
&lt;input type="tel"&gt;            &lt;!-- Phone number --&gt;
&lt;input type="search"&gt;         &lt;!-- Search box --&gt;
&lt;input type="url"&gt;            &lt;!-- URL with validation --&gt;

&lt;!-- Autocomplete dropdown --&gt;
&lt;input list="languages" placeholder="Choose language"&gt;
&lt;datalist id="languages"&gt;
  &lt;option value="HTML"&gt;
  &lt;option value="CSS"&gt;
  &lt;option value="JavaScript"&gt;
&lt;/datalist&gt;

&lt;!-- Multi-line text --&gt;
&lt;textarea rows="4" cols="50" placeholder="Your message..."&gt;&lt;/textarea&gt;

&lt;!-- Dropdown select --&gt;
&lt;select name="country"&gt;
  &lt;option value=""&gt;-- Select Country --&lt;/option&gt;
  &lt;option value="ph"&gt;Philippines&lt;/option&gt;
  &lt;option value="us"&gt;United States&lt;/option&gt;
&lt;/select&gt;</pre>
<h3>HTML5 Canvas</h3>
<p>The <code>&lt;canvas&gt;</code> element is a blank drawing board. You use JavaScript to draw shapes, images, and animations on it. It is widely used for games, charts, and visual effects:</p>
<pre>&lt;canvas id="myCanvas" width="400" height="200"&gt;&lt;/canvas&gt;
&lt;script&gt;
  const ctx = document.getElementById('myCanvas').getContext('2d');
  ctx.fillStyle = 'purple';
  ctx.fillRect(10, 10, 150, 75);   // x, y, width, height
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, 150, 75); // draws border
&lt;/script&gt;</pre>
<h3>HTML5 Web Storage</h3>
<p>HTML5 provides browser storage APIs accessible through JavaScript to save data locally without a server:</p>
<pre>localStorage.setItem('username', 'Alice');   // Save
const name = localStorage.getItem('username'); // Read: "Alice"
localStorage.removeItem('username');           // Delete</pre>
<div class="tip-box">&#x1F4A1; <code>data-*</code> attributes are one of the most practical HTML features &mdash; use them to store IDs, states, or config values on elements so your JavaScript can easily read them with <code>element.dataset</code>!</div>
`,
                questions: [
    { q: "Which tag is used to embed another webpage inside your page?", o: ["&lt;embed&gt;","&lt;frame&gt;","&lt;iframe&gt;","&lt;include&gt;"], c: 2 },
    { q: "How do you access a data-user-id attribute in JavaScript?", o: ["element.data.userId","element.getAttribute('user-id')","element.dataset.userId","element.userID"], c: 2 },
    { q: "Which input type shows a color picker?", o: ["type='picker'","type='color'","type='palette'","type='rgb'"], c: 1 },
    { q: "What HTML5 element is used for drawing graphics via JavaScript?", o: ["&lt;draw&gt;","&lt;svg&gt;","&lt;canvas&gt;","&lt;graphic&gt;"], c: 2 },
    { q: "Which element pairs with &lt;input list&gt; to provide autocomplete options?", o: ["&lt;options&gt;","&lt;select&gt;","&lt;datalist&gt;","&lt;autocomplete&gt;"], c: 2 },
    { q: "What does the allowfullscreen attribute do on an &lt;iframe&gt;?", o: ["Makes the iframe take full page width","Allows the embedded content to go fullscreen","Removes the iframe border","Auto-plays video inside it"], c: 1 },
    { q: "Which input type is best for a phone number field on mobile?", o: ["type='text'","type='number'","type='tel'","type='phone'"], c: 2 },
    { q: "What method stores data in the browser using HTML5 Web Storage?", o: ["localStorage.save()","localStorage.setItem()","localStorage.store()","localStorage.write()"], c: 1 },
    { q: "What does the step attribute do on &lt;input type='range'&gt;?", o: ["Sets the minimum value","Sets the maximum value","Controls how much the slider moves per step","Changes the slider color"], c: 2 },
    { q: "What does getContext('2d') return when used on a canvas element?", o: ["The canvas HTML element","A 2D drawing context object","The canvas width and height","A list of colors"], c: 1 },
    { q: "What is the purpose of data attributes in HTML?", o: ["To style elements","To store custom user data attached to elements","To create form submissions","To trigger animations"], c: 1 },
    { q: "How do you name a data attribute correctly?", o: ["data_name","data-name","data.name","dataname"], c: 1 },
    { q: "Which input type is best for selecting a date?", o: ["type='text'","type='calendar'","type='date'","type='datetime'"], c: 2 },
    { q: "What does the sandbox attribute do on an &lt;iframe&gt;?", o: ["Speeds up loading","Restricts permissions of embedded content","Adds a border around it","Hides the iframe"], c: 1 },
    { q: "Can you store large amounts of data with localStorage?", o: ["Yes, unlimited","No, typically 5-10MB limit","Only text, no objects","Only numbers"], c: 1 },
    { q: "What is sessionStorage used for?", o: ["Permanent browser storage","Temporary storage cleared when tab closes","Caching CSS files","Storing server session IDs"], c: 1 },
    { q: "What input type provides a slider control?", o: ["type='slider'","type='range'","type='scroll'","type='drag'"], c: 1 },
    { q: "Can a canvas element display text?", o: ["No, only shapes","Yes, using context.fillText()","Only with external JavaScript library","Canvas can't be used for text"], c: 1 },
    { q: "What does contentEditable attribute do?", o: ["Makes elements editable in the browser","Enables some edit tools","Stores edited content","Prevents copying"], c: 0 },
    { q: "What is the &lt;progress&gt; element used for?", o: ["Creating a loading bar animation","Showing task completion percentage","Starting download progress","Measuring runtime"], c: 1 },
    { q: "What does an &lt;iframe&gt; title attribute improve?", o: ["Visual appearance","SEO ranking","Accessibility for screen reader users","Loading speed"], c: 2 }
]
            }
        ]
    },

    js: {
        title: '&#x26A1; JavaScript Track',
        subtitle: 'Add logic, interactivity, and power to your web pages.',
        modules: [
            {
                id: 'js1', rank: 'F', num: 1,
                name: 'Introduction to JavaScript and Computer Programming',
                desc: 'Understand what programming is, what JavaScript does, and how to write your first script.',
                reviewer: `
<h3>What is JavaScript?</h3>
<p>JavaScript is a <strong>programming language</strong> that runs directly in the browser. While HTML gives a page its structure and CSS gives it style, JavaScript gives it <em>behavior</em> &mdash; it makes pages respond to what the user does. Clicking a button, submitting a form, showing a popup, loading new content without refreshing &mdash; all of that is JavaScript.</p>
<p>JavaScript also runs on servers through <strong>Node.js</strong>, which means you can use one language for both the front-end and back-end of a web application.</p>
<h3>Adding JavaScript to HTML</h3>
<p>There are two ways to include JavaScript in an HTML page:</p>
<pre>&lt;!-- Internal: written directly inside a script tag --&gt;
&lt;script&gt;
  console.log("Hello from JS!");
&lt;/script&gt;

&lt;!-- External (recommended): linked from a separate .js file --&gt;
&lt;script src="script.js"&gt;&lt;/script&gt;</pre>
<p>Always place the <code>&lt;script&gt;</code> tag just before <code>&lt;/body&gt;</code> so the HTML loads first before JavaScript tries to interact with it.</p>
<h3>Your First JavaScript Program</h3>
<pre>// This is a single-line comment
/* This is a
   multi-line comment */

console.log("Hello, World!");    // Prints to the browser console
alert("Welcome to JavaScript!"); // Shows a popup message
document.write("&lt;h1&gt;Hello!&lt;/h1&gt;"); // Writes directly to the page</pre>
<h3>What is an Algorithm?</h3>
<p>An algorithm is a <strong>step-by-step set of instructions</strong> to solve a specific problem. Every program you write is essentially an algorithm. Before coding, it helps to think through your steps in plain English first &mdash; this is called <strong>pseudocode</strong>.</p>
<p>Example algorithm for making tea:</p>
<ul>
<li>1. Boil water</li>
<li>2. Place tea bag in cup</li>
<li>3. Pour hot water into cup</li>
<li>4. Wait 3 minutes</li>
<li>5. Remove tea bag</li>
<li>6. Add sugar if desired</li>
</ul>
<h3>Key Programming Concepts</h3>
<ul>
<li><strong>Syntax</strong> &mdash; The grammar rules of the language. Breaking syntax causes errors and the program will not run.</li>
<li><strong>Statement</strong> &mdash; A single instruction. Usually ends with a semicolon <code>;</code></li>
<li><strong>Expression</strong> &mdash; Any code that produces a value: <code>2 + 2</code>, <code>"hello"</code></li>
<li><strong>Comment</strong> &mdash; Notes for humans, completely ignored by the computer: <code>// single line</code> or <code>/* multi line */</code></li>
<li><strong>Console</strong> &mdash; The developer tool where <code>console.log()</code> prints output for debugging</li>
</ul>
<div class="tip-box">&#x1F4A1; Open your browser DevTools with F12, go to the Console tab, and try typing <code>alert("Hello!")</code> then pressing Enter. JavaScript runs live right there!</div>
`,
                questions: [
    { q: "What is JavaScript primarily used for in web development?", o: ["Styling pages","Structuring content","Adding interactivity","Managing databases"], c: 2 },
    { q: "Which method prints output to the browser console?", o: ["print()","document.write()","console.log()","alert()"], c: 2 },
    { q: "How do you write a single-line comment in JavaScript?", o: ["# comment","<!-- comment -->","// comment","** comment"], c: 2 },
    { q: "Where is the BEST place to put an external script tag?", o: ["Inside &lt;head&gt;","At the top of &lt;body&gt;","Before &lt;/body&gt;","Inside &lt;title&gt;"], c: 2 },
    { q: "What is an algorithm?", o: ["A type of variable","A step-by-step problem-solving process","A JavaScript library","A type of loop"], c: 1 },
    { q: "What does alert() do in JavaScript?", o: ["Prints to the console","Writes text to the page","Shows a popup message box","Sends an email"], c: 2 },
    { q: "What platform allows JavaScript to run on a server?", o: ["Apache","Django","Node.js","PHP"], c: 2 },
    { q: "What is pseudocode?", o: ["A broken JavaScript program","A description of steps in plain language before writing code","A type of HTML comment","A CSS variable"], c: 1 },
    { q: "What does a semicolon do at the end of a JavaScript statement?", o: ["Starts a new function","Marks the end of a statement","Creates a comment","Closes a block"], c: 1 },
    { q: "Which of these is NOT a valid way to open DevTools in a browser?", o: ["Pressing F12","Right-clicking and choosing Inspect","Pressing Ctrl+Shift+I","Pressing Ctrl+S"], c: 3 },
    { q: "Can JavaScript be used on the backend?", o: ["No, only in browsers","Yes, with Node.js","Only with special plugins","Only in React"], c: 1 },
    { q: "What was JavaScript originally called?", o: ["JavaCode","Mocha","LiveScript","InternetScript"], c: 2 },
    { q: "What does DOM stand for?", o: ["Data Object Model","Document Object Model","Dynamic Operating Mode","Digital Output Model"], c: 1 },
    { q: "Which company created JavaScript?", o: ["Microsoft","Google","Netscape","Apple"], c: 2 },
    { q: "What year was JavaScript created?", o: ["1990","1995","2000","2010"], c: 1 },
    { q: "Is JavaScript a compiled or interpreted language?", o: ["Compiled","Interpreted","Both","Neither"], c: 1 },
    { q: "Can JavaScript access files on your computer?", o: ["Yes, freely","No, for security reasons","Only with permission","Only text files"], c: 1 },
    { q: "What does JavaScript do when you press Enter in a console?", o: ["Saves the file","Executes the code","Clears the console","Sends data to server"], c: 1 },
    { q: "What is the correct file extension for JavaScript files?", o: [".txt",".js",".javascript",".script"], c: 1 },
    { q: "How many times should you declare the same variable?", o: ["As many times as needed","Once in the same scope","Whenever you use it","Never"], c: 1 },
    { q: "What does the 'use strict' directive do?", o: ["Enforces stricter parsing","Speeds up code","Enables all features","Disables HTML"], c: 0 }
]
            },
            {
                id: 'js2', rank: 'E', num: 2,
                name: 'Variables, Data Types, Type Casting, and Comments',
                desc: 'Store and work with data using variables, understand data types, and cast between them.',
                reviewer: `
<h3>Variables</h3>
<p>A variable is a <strong>named container</strong> that stores a value. Think of it like a labeled box &mdash; you put something in it and refer to it by the label later. JavaScript has three ways to declare variables:</p>
<pre>var oldWay = "avoid this";    // Old ES5 way, has scoping issues
let name = "Alice";            // Modern, block-scoped, can be reassigned
const PI = 3.14159;            // Modern, block-scoped, CANNOT be reassigned</pre>
<h3>When to Use let vs const</h3>
<p>Use <code>const</code> by default for everything. Only switch to <code>let</code> if you know the value needs to change later. This makes your code more predictable and easier to debug.</p>
<h3>Data Types</h3>
<p>JavaScript has 8 data types. The first 7 are called <strong>primitive</strong> (simple values):</p>
<ul>
<li><strong>String</strong> &mdash; Text: <code>"Hello"</code>, <code>'World'</code>, or <code>\`template\`</code></li>
<li><strong>Number</strong> &mdash; Any number: <code>42</code>, <code>3.14</code>, <code>-7</code>, <code>Infinity</code></li>
<li><strong>Boolean</strong> &mdash; Only two values: <code>true</code> or <code>false</code></li>
<li><strong>Null</strong> &mdash; Intentionally empty: <code>null</code></li>
<li><strong>Undefined</strong> &mdash; Variable declared but no value assigned yet</li>
<li><strong>BigInt</strong> &mdash; Very large integers: <code>9007199254740991n</code></li>
<li><strong>Symbol</strong> &mdash; Unique identifier used in advanced programming</li>
<li><strong>Object</strong> &mdash; Complex data including arrays: <code>{ name: "Alice", age: 20 }</code></li>
</ul>
<h3>Type Casting</h3>
<p>Converting one data type to another is called type casting or type conversion:</p>
<pre>// Converting TO a Number
Number("42")        // 42
Number(true)        // 1
Number(false)       // 0
Number("hello")     // NaN (Not a Number)
parseInt("42px")    // 42 (ignores non-numeric suffix)
parseFloat("3.5em") // 3.5

// Converting TO a String
String(100)         // "100"
String(true)        // "true"
(100).toString()    // "100"
(255).toString(16)  // "ff" (converts to hexadecimal!)

// Converting TO a Boolean
Boolean(0)          // false
Boolean("")         // false
Boolean(null)       // false
Boolean(undefined)  // false
Boolean("hello")    // true (any non-empty string)
Boolean(42)         // true (any non-zero number)</pre>
<h3>Checking Types with typeof</h3>
<pre>typeof "hello"      // "string"
typeof 42           // "number"
typeof true         // "boolean"
typeof undefined    // "undefined"
typeof null         // "object"  &mdash; Famous JS quirk!
typeof {}           // "object"
typeof []           // "object"  &mdash; Arrays are objects in JS
typeof function(){} // "function"</pre>
<div class="tip-box">&#x1F4A1; Use <code>const</code> by default, <code>let</code> when you need to reassign. Never use <code>var</code> in modern JavaScript &mdash; it has unpredictable scoping behavior!</div>
`,
                questions: [
    { q: "Which keyword declares a variable that CANNOT be reassigned?", o: ["var","let","const","static"], c: 2 },
    { q: "What data type is the value: true?", o: ["String","Number","Boolean","Null"], c: 2 },
    { q: "What does typeof null return? (JavaScript quirk)", o: ["null","undefined","object","boolean"], c: 2 },
    { q: "Which function converts a string '42' to an integer?", o: ["toInt()","Number.parse()","parseInt()","convert()"], c: 2 },
    { q: "What is the value of an uninitialized variable in JavaScript?", o: ["null","0","false","undefined"], c: 3 },
    { q: "What does Number('hello') return?", o: ["0","null","undefined","NaN"], c: 3 },
    { q: "Which is the modern block-scoped variable that CAN be reassigned?", o: ["var","let","const","def"], c: 1 },
    { q: "What does parseInt('42px') return?", o: ["Error","'42px'","NaN","42"], c: 3 },
    { q: "What does Boolean(0) return?", o: ["true","false","0","null"], c: 1 },
    { q: "What does typeof [] return in JavaScript?", o: ["array","list","object","undefined"], c: 2 },
    { q: "What are the different data types in JavaScript?", o: ["Only String and Number","String, Number, Boolean, null, undefined, Object, Symbol","Only primitive types","String, Number, Array"], c: 1 },
    { q: "What does NaN stand for?", o: ["Not a Node","Not a Number","Null and Nothing","Negative Array Notation"], c: 1 },
    { q: "How do you check if a value is NaN?", o: ["value === NaN","isNaN(value)","value == 'NaN'","typeof value === NaN"], c: 1 },
    { q: "What is the difference between null and undefined?", o: ["No difference","null is assigned by programmer, undefined is default","undefined is assigned, null is default","They're for different types"], c: 1 },
    { q: "Can you change a const variable after declaring it?", o: ["Yes, always","No, it's constant","Only if you reassign","Only in objects"], c: 1 },
    { q: "What happens when you try to add a string and a number?", o: ["Error","The number is converted to string and concatenated","The string is converted to number","Returns undefined"], c: 1 },
    { q: "What does '5' + 3 evaluate to?", o: ["8","'53'","Error","undefined"], c: 1 },
    { q: "What does 5 + '3' evaluate to?", o: ["8","'53'","Error","undefined"], c: 1 },
    { q: "What do you call converting between data types?", o: ["Parsing","Type casting","Boxing","Serializing"], c: 1 },
    { q: "What does String(123) return?", o: ["123","'123'","Error","NaN"], c: 1 },
    { q: "Is 'length' a property or method?", o: ["Method, must call it","Property, use dot notation","Both","Neither"], c: 1 }
]
            },
            {
                id: 'js3', rank: 'D', num: 3,
                name: 'Operators and User Interaction',
                desc: 'Use arithmetic, comparison, and logical operators, and interact with users via dialogs.',
                reviewer: `
<h3>Arithmetic Operators</h3>
<p>Arithmetic operators perform math on numbers. JavaScript follows standard mathematical order of operations:</p>
<pre>let a = 10, b = 3;
a + b    // 13   &mdash; Addition
a - b    // 7    &mdash; Subtraction
a * b    // 30   &mdash; Multiplication
a / b    // 3.333... &mdash; Division
a % b    // 1    &mdash; Modulus (remainder after division)
a ** b   // 1000 &mdash; Exponentiation (10 to the power of 3)
a++      // Returns 10 then becomes 11 (post-increment)
++a      // Becomes 11 first then uses 11 (pre-increment)
a--      // Decrement by 1</pre>
<h3>Assignment Operators</h3>
<pre>let x = 10;
x += 5;   // x = x + 5  = 15
x -= 3;   // x = x - 3  = 12
x *= 2;   // x = x * 2  = 24
x /= 4;   // x = x / 4  = 6
x %= 4;   // x = x % 4  = 2
x **= 3;  // x = x ** 3 = 8</pre>
<h3>Comparison Operators</h3>
<p>Comparison operators always return <code>true</code> or <code>false</code>:</p>
<pre>5 == "5"    // true  &mdash; Loose equality (only checks VALUE)
5 === "5"   // false &mdash; Strict equality (checks VALUE and TYPE)
5 != "5"    // false &mdash; Loose not equal
5 !== "5"   // true  &mdash; Strict not equal
5 > 3       // true
5 < 3       // false
5 >= 5      // true
5 <= 4      // false</pre>
<h3>Logical Operators</h3>
<pre>true &amp;&amp; false   // false &mdash; AND: BOTH must be true
true || false   // true  &mdash; OR: at least ONE must be true
!true           // false &mdash; NOT: flips the boolean

// Nullish coalescing operator
let username = null;
let display = username ?? "Guest"; // "Guest" if username is null or undefined</pre>
<h3>User Interaction Dialogs</h3>
<pre>alert("Hello!");                     // Shows message, user clicks OK
let name = prompt("What is your name?", "Default"); // Gets text from user
let ok = confirm("Are you sure?");   // Returns true (OK) or false (Cancel)</pre>
<h3>String Operations</h3>
<pre>let name = "Alice";
"Hello " + name           // "Hello Alice" &mdash; concatenation
\`Hello \${name}!\`          // "Hello Alice!" &mdash; template literal
\`2 + 2 = \${2 + 2}\`        // "2 + 2 = 4" &mdash; expressions in templates
name.length               // 5
name.toUpperCase()        // "ALICE"
name.toLowerCase()        // "alice"
name.includes("lic")      // true</pre>
<div class="tip-box">&#x1F4A1; Always use <code>===</code> (strict equality) instead of <code>==</code> (loose equality). The loose version does type coercion which causes very hard-to-find bugs!</div>
`,
                questions: [
    { q: "What does the % operator do?", o: ["Division","Percentage","Returns the remainder","Converts to percent"], c: 2 },
    { q: "Which operator checks BOTH value and type?", o: ["==","!=","===",">="], c: 2 },
    { q: "What does prompt() return?", o: ["A number","A boolean","A string from user input","undefined"], c: 2 },
    { q: "What does the && operator mean?", o: ["OR","NOT","AND","XOR"], c: 2 },
    { q: "What is the result of: 10 % 3?", o: ["3","1","0","3.33"], c: 1 },
    { q: "What does x += 5 mean?", o: ["x = 5","x = x - 5","x = x + 5","x = x * 5"], c: 2 },
    { q: "What does 5 === '5' evaluate to?", o: ["true","false","undefined","Error"], c: 1 },
    { q: "What does confirm() return when the user clicks Cancel?", o: ["null","undefined","true","false"], c: 3 },
    { q: "What does the ?? operator do?", o: ["Checks strict equality","Returns right side if left is null or undefined","Logical AND","Converts to boolean"], c: 1 },
    { q: "What is the result of: 2 ** 8?", o: ["16","64","256","512"], c: 2 },
    { q: "What does the || operator mean?", o: ["AND","OR","NOT","XOR"], c: 1 },
    { q: "What does ! do to a boolean?", o: ["Converts to number","Negates/flips it","Returns opposite value","No effect"], c: 1 },
    { q: "What is the result of: true && false?", o: ["true","false","null","undefined"], c: 1 },
    { q: "What is the result of: true || false?", o: ["true","false","null","undefined"], c: 0 },
    { q: "Does == do type coercion?", o: ["No","Yes, it's why === is better","Only for strings","Only for numbers"], c: 1 },
    { q: "What does prompt() show to the user?", o: ["A popup window","The browser console","The DevTools","The address bar"], c: 0 },
    { q: "Can prompt() be used for passwords?", o: ["Yes, safely","No, text is visible (use proper forms)","Only with HTTPS","Only in Node.js"], c: 1 },
    { q: "What comparison operator checks if two values are NOT equal?", o: ["=","!=","!==","<"], c: 1 },
    { q: "Is '' == false true or false?", o: ["true, loose equality","false, strict equality","undefined","Error"], c: 0 },
    { q: "What's the difference between == and ===?", o: ["No difference","== does type coercion, === is strict","=== is deprecated","They work only with numbers"], c: 1 },
    { q: "What does the ternary operator ? : do?", o: ["Creates a range","Conditional expression (if ? then : else)","Combines two values","Creates a loop"], c: 1 }
]
            },
            {
                id: 'js4', rank: 'C', num: 4,
                name: 'Control Flow: Conditional Execution and Loops',
                desc: 'Control what your code does with if/else statements, switch cases, and loops.',
                reviewer: `
<h3>If / Else Statements</h3>
<p>Conditions let your program make decisions. The code inside <code>if</code> only runs when the condition is <code>true</code>:</p>
<pre>let score = 75;

if (score >= 90) {
    console.log("A Grade");
} else if (score >= 80) {
    console.log("B Grade");
} else if (score >= 75) {
    console.log("C Grade");
} else {
    console.log("Below passing");
}</pre>
<h3>Ternary Operator</h3>
<p>A shorthand for simple if/else written in one line:</p>
<pre>let age = 20;
let status = age >= 18 ? "Adult" : "Minor";
// Reads as: if age >= 18 then "Adult" else "Minor"
console.log(status); // "Adult"</pre>
<h3>Switch Statement</h3>
<p>Switch is better than a long chain of if/else when comparing one variable to many specific values:</p>
<pre>let day = "Monday";
switch(day) {
    case "Monday":
        console.log("Start of the week");
        break;
    case "Friday":
        console.log("Almost weekend!");
        break;
    case "Saturday":
    case "Sunday":
        console.log("Weekend!");
        break;
    default:
        console.log("Midweek");
}</pre>
<h3>Loops</h3>
<p>Loops repeat code. Choose the right loop for the right situation:</p>
<pre>// For loop &mdash; when you know exactly how many times
for (let i = 0; i < 5; i++) {
    console.log(i); // 0 1 2 3 4
}

// While loop &mdash; when you don't know how many times
let x = 0;
while (x < 3) {
    console.log(x);
    x++;
}

// Do...while &mdash; always runs at least once
let attempts = 0;
do {
    console.log("Attempt:", attempts);
    attempts++;
} while (attempts < 3);

// For...of &mdash; iterating over array values
let fruits = ["apple", "banana", "mango"];
for (let fruit of fruits) {
    console.log(fruit);
}

// For...in &mdash; iterating over object keys
let person = { name: "Alice", age: 20 };
for (let key in person) {
    console.log(key, ":", person[key]);
}</pre>
<h3>break and continue</h3>
<pre>for (let i = 0; i < 10; i++) {
    if (i === 3) continue;  // Skip 3, jump to next iteration
    if (i === 7) break;     // Stop the loop entirely at 7
    console.log(i);          // Prints: 0 1 2 4 5 6
}</pre>
<div class="tip-box">&#x1F4A1; Don't forget <code>break</code> in switch statements! Without it, JavaScript will continue running all cases below the match &mdash; this is called "fall-through" and is usually a bug!</div>
`,
                questions: [
    { q: "What keyword exits a switch case?", o: ["exit","stop","return","break"], c: 3 },
    { q: "Which loop is best when you know the exact number of iterations?", o: ["while","do...while","for","for...in"], c: 2 },
    { q: "What does a 'for...of' loop iterate over?", o: ["Object keys","Object values","Iterable values like arrays","Numbers only"], c: 2 },
    { q: "What happens if no 'if' or 'else if' condition is true?", o: ["The program crashes","The else block runs","Nothing happens","It repeats"], c: 1 },
    { q: "What is the output of: for(let i=0;i<3;i++) console.log(i)?", o: ["1 2 3","0 1 2","0 1 2 3","1 2"], c: 1 },
    { q: "What does the continue keyword do inside a loop?", o: ["Stops the loop","Skips the current iteration and continues","Restarts from the beginning","Returns a value"], c: 1 },
    { q: "What is the ternary operator syntax?", o: ["if(cond) ? val1 : val2","cond ? val1 : val2","cond ?? val1 : val2","cond : val1 ? val2"], c: 1 },
    { q: "Which loop always executes its body at least once?", o: ["for","while","do...while","for...of"], c: 2 },
    { q: "What does 'for...in' iterate over?", o: ["Array values","String characters","Object keys","Numbers in a range"], c: 2 },
    { q: "In a switch statement, what does the 'default' case do?", o: ["Always runs first","Runs when no other case matches","Stops the switch","Is required in every switch"], c: 1 },
    { q: "What happens in a switch without 'break'?", o: ["An error occurs","Execution continues to next case (fall-through)","The switch ends","It repeats"], c: 1 },
    { q: "Can you nest if statements inside each other?", o: ["No, not allowed","Yes, but it's not recommended","Yes, and it's common","Only inside functions"], c: 2 },
    { q: "Which is more efficient: one while loop or nested for loops?", o: ["While loops","For loops","Depends on the situation","They're identical"], c: 2 },
    { q: "What does a while(true) loop do?", o: ["Executes once","Loops forever (infinite loop)","Never executes","Stops after 1 iteration"], c: 1 },
    { q: "How can you exit an infinite loop?", o: ["You can't","With break or return","By pressing Enter","By reopening the browser"], c: 1 },
    { q: "What's the difference between 'if' and 'else if'?", o: ["No difference","else if only runs if previous if was false","if only runs once","else if is older syntax"], c: 1 },
    { q: "Can you have multiple 'else if' statements?", o: ["No, only one","Yes, as many as needed","Only two","Only in modern JavaScript"], c: 1 },
    { q: "Does a for loop require a condition?", o: ["Yes, always","No, all three parts are optional","Only the init part","Only the increment part"], c: 1 },
    { q: "What does break do in a switch?", o: ["Exits the switch block","Stops the program","Restarts the switch","Skips to next case"], c: 0 },
    { q: "Is the else block required in an if statement?", o: ["Yes, always","No, it's optional","Only for numbers","Only for strings"], c: 1 },
    { q: "What's the range of a for loop: for(let i=0; i<5; i++)?", o: ["0-5","0-4","1-5","0-5 including 5"], c: 1 }
]
            },
            {
                id: 'js5', rank: 'B', num: 5,
                name: 'Functions',
                desc: 'Write reusable code blocks using function declarations, expressions, and arrow functions.',
                reviewer: `
<h3>What is a Function?</h3>
<p>A function is a <strong>reusable block of code</strong> that performs a specific task. Instead of writing the same code multiple times, you write it once in a function and call it whenever you need it. Functions make code organized, readable, and maintainable.</p>
<h3>Function Declaration</h3>
<p>The traditional way to define a function. Declarations are <strong>hoisted</strong> &mdash; you can call them before they are defined in the file:</p>
<pre>function greet(name) {
    return "Hello, " + name + "!";
}
console.log(greet("Alice")); // "Hello, Alice!"
console.log(greet("Bob"));   // "Hello, Bob!"</pre>
<h3>Function Expression</h3>
<p>Assigning a function to a variable. These are NOT hoisted &mdash; you must define them before calling:</p>
<pre>const square = function(n) {
    return n * n;
};
console.log(square(4)); // 16</pre>
<h3>Arrow Functions (ES6)</h3>
<p>A shorter modern syntax. Most common in modern JavaScript code:</p>
<pre>// Full arrow function
const add = (a, b) => {
    return a + b;
};

// Implicit return: single expression, no curly braces needed
const multiply = (a, b) => a * b;

// Single parameter: no parentheses needed
const double = n => n * 2;

// No parameters
const sayHello = () => "Hello!";

console.log(add(3, 4));       // 7
console.log(multiply(3, 4));  // 12
console.log(double(5));       // 10</pre>
<h3>Default Parameters</h3>
<pre>function greet(name = "stranger", greeting = "Hello") {
    return \`\${greeting}, \${name}!\`;
}
greet()                 // "Hello, stranger!"
greet("Alice")          // "Hello, Alice!"
greet("Bob", "Hi")      // "Hi, Bob!"</pre>
<h3>Rest Parameters and Spread</h3>
<pre>// Rest: collect multiple arguments into an array
function sum(...numbers) {
    return numbers.reduce((total, n) => total + n, 0);
}
sum(1, 2, 3, 4, 5); // 15

// Spread: expand an array into individual arguments
const nums = [1, 2, 3];
console.log(Math.max(...nums)); // 3</pre>
<h3>Higher-Order Functions</h3>
<p>Functions that take other functions as arguments or return functions:</p>
<pre>const nums = [1, 2, 3, 4, 5];
nums.map(n => n * 2)                  // [2, 4, 6, 8, 10]
nums.filter(n => n > 2)               // [3, 4, 5]
nums.reduce((acc, n) => acc + n, 0)   // 15
nums.find(n => n > 3)                 // 4
nums.every(n => n > 0)                // true
nums.some(n => n > 4)                 // true</pre>
<div class="tip-box">&#x1F4A1; Arrow functions do NOT have their own <code>this</code> keyword &mdash; they inherit it from the surrounding scope. This is why they are preferred in callbacks but should NOT be used as object methods!</div>
`,
                questions: [
    { q: "What keyword is used to send a value back from a function?", o: ["send","output","return","give"], c: 2 },
    { q: "Which is the correct arrow function syntax?", o: ["function => (x) x*2","(x) => x * 2","x -> x*2","arrow(x) { x*2 }"], c: 1 },
    { q: "What are default parameters used for?", o: ["Setting max values","Providing fallback values if none are passed","Making functions faster","Preventing errors only"], c: 1 },
    { q: "What does .map() do to an array?", o: ["Filters items","Finds one item","Returns a new array with each item transformed","Sorts the array"], c: 2 },
    { q: "What is a variable's 'scope'?", o: ["Its data type","Where in code it can be accessed","How fast it is","Its default value"], c: 1 },
    { q: "What does the rest parameter (...args) do?", o: ["Spreads an array","Collects multiple arguments into an array","Copies a function","Pauses execution"], c: 1 },
    { q: "What does .filter() return?", o: ["A single value","The first matching item","A new array with only items that pass the test","The index of matching items"], c: 2 },
    { q: "What is function hoisting?", o: ["Moving functions to the bottom","Function declarations can be called before they are defined","Making functions run faster","A type of arrow function"], c: 1 },
    { q: "What does .reduce() do?", o: ["Removes items from an array","Transforms each item","Accumulates array values into a single result","Sorts the array"], c: 2 },
    { q: "What does .find() return if no match is found?", o: ["null","false","0","undefined"], c: 3 },
    { q: "What is a callback function?", o: ["A function that prints output","A function passed to another function to be called later","A function that only returns values","A type of arrow function"], c: 1 },
    { q: "Can a function have no parameters?", o: ["No, at least one is required","Yes, they're optional","Only arrow functions allow this","Only in modern JavaScript"], c: 1 },
    { q: "What does the spread operator (...) do in function calls?", o: ["Creates a copy","Expands an array into individual arguments","Joins arrays","Removes duplicates"], c: 1 },
    { q: "What is a pure function?", o: ["A function with perfect syntax","Function with no side effects, same input = same output","A function without parameters","A built-in JavaScript function"], c: 1 },
    { q: "Can functions return other functions?", o: ["No, not allowed","Yes, this is called higher-order function","Only with arrow functions","Only in modern browsers"], c: 1 },
    { q: "What does .forEach() do?", o: ["Returns a filtered array","Loops through each item and executes a callback","Finds the first match","Sorts arrays"], c: 1 },
    { q: "What is the difference between parameters and arguments?", o: ["No difference","Parameters are in definition, arguments are passed when calling","Arguments are in definition, parameters are passed","Arguments are permanent, parameters are temporary"], c: 1 },
    { q: "What does .some() return?", o: ["The first matching item","An array of matches","true if at least one item matches, false otherwise","The number of matches"], c: 2 },
    { q: "What does .every() check?", o: ["If array has items","If all items pass a test","If any item passes a test","The array length"], c: 1 },
    { q: "Can you declare a function inside another function?", o: ["No","Yes, it will have its own scope","Only with arrow functions","Only at the top level"], c: 1 },
    { q: "What does an anonymous function do?", o: ["Throws errors frequently","A function without a name, often used as callback","A function that disappears","A function with no parameters"], c: 1 }
]
            },
            {
                id: 'js6', rank: 'A', num: 6,
                name: 'Errors, Exceptions, Debugging, and Troubleshooting',
                desc: 'Handle errors gracefully with try/catch, understand error types, and debug like a pro.',
                reviewer: `
<h3>Types of JavaScript Errors</h3>
<p>JavaScript has several built-in error types. Knowing which type you have tells you exactly where to look:</p>
<ul>
<li><strong>SyntaxError</strong> &mdash; Code that cannot be parsed at all. The program will not even start. Example: <code>if (x {</code></li>
<li><strong>ReferenceError</strong> &mdash; Using a variable that was never declared. Example: <code>console.log(undeclaredVar)</code></li>
<li><strong>TypeError</strong> &mdash; Performing an operation on the wrong data type. Example: calling <code>null.toString()</code></li>
<li><strong>RangeError</strong> &mdash; A value is outside its allowed range. Example: <code>new Array(-1)</code></li>
<li><strong>URIError</strong> &mdash; Invalid URI encoding or decoding</li>
<li><strong>EvalError</strong> &mdash; Issues with the eval() function</li>
</ul>
<h3>Try / Catch / Finally</h3>
<p>Wrapping code in try/catch prevents errors from crashing your entire program:</p>
<pre>try {
    let result = riskyOperation();
    console.log(result);
} catch (error) {
    console.error("Error caught:", error.message);
    console.error("Error type:", error.name);
} finally {
    console.log("Cleanup complete");
    hideLoadingSpinner();
}</pre>
<h3>Throwing Custom Errors</h3>
<p>You can throw your own errors to handle invalid inputs or states:</p>
<pre>function divide(a, b) {
    if (typeof a !== 'number' || typeof b !== 'number') {
        throw new TypeError("Both arguments must be numbers");
    }
    if (b === 0) {
        throw new RangeError("Cannot divide by zero!");
    }
    return a / b;
}

try {
    console.log(divide(10, 0));
} catch(e) {
    console.log(e.name + ": " + e.message);
    // "RangeError: Cannot divide by zero!"
}</pre>
<h3>Debugging Techniques</h3>
<ul>
<li><code>console.log(value)</code> &mdash; Print a value to check it at a certain point</li>
<li><code>console.error(msg)</code> &mdash; Red error message in console</li>
<li><code>console.warn(msg)</code> &mdash; Yellow warning message</li>
<li><code>console.table(array)</code> &mdash; Display array or object as a formatted table</li>
<li><code>console.time("label")</code> / <code>console.timeEnd("label")</code> &mdash; Measure execution time</li>
<li><strong>Breakpoints</strong> &mdash; In DevTools F12 Sources tab, click a line number to pause execution there</li>
<li><strong>debugger;</strong> &mdash; Write this keyword in your code to trigger a breakpoint programmatically</li>
</ul>
<h3>Common Bugs and How to Spot Them</h3>
<pre>// Bug 1: Wrong variable name (ReferenceError)
let userName = "Alice";
console.log(username); // Error! 'username' vs 'userName'

// Bug 2: Loose equality causing wrong result
if (0 == false) { /* This is TRUE! Always use === */ }

// Bug 3: Missing closing bracket
function test() {
    if (true) {
        console.log("hi");
    // Missing closing } causes SyntaxError
}

// Good debugging habit: log at each step
function buggyAdd(a, b) {
    console.log("a =", a, "b =", b);
    let result = a + b;
    console.log("result =", result);
    return result;
}</pre>
<div class="tip-box">&#x1F4A1; The <code>finally</code> block always runs no matter what &mdash; perfect for cleanup tasks like hiding loading spinners, closing database connections, or releasing resources!</div>
`,
                questions: [
    { q: "Which error type occurs when you use a variable that hasn't been declared?", o: ["TypeError","SyntaxError","RangeError","ReferenceError"], c: 3 },
    { q: "What block ALWAYS runs in a try/catch/finally?", o: ["try","catch","finally","All of them"], c: 2 },
    { q: "How do you manually throw an error in JavaScript?", o: ["raise Error()","throw new Error('msg')","error('msg')","crash('msg')"], c: 1 },
    { q: "Which console method is best for displaying errors?", o: ["console.log()","console.warn()","console.error()","console.debug()"], c: 2 },
    { q: "What is a SyntaxError?", o: ["Using wrong data type","Using undefined variable","Code that cannot be parsed","Division by zero"], c: 2 },
    { q: "What keyword can you write in code to trigger a DevTools breakpoint?", o: ["pause","stop","debugger","breakpoint"], c: 2 },
    { q: "What does console.table() do?", o: ["Draws an HTML table","Displays arrays or objects as a formatted table in the console","Logs only table elements","Creates a database table"], c: 1 },
    { q: "Which error type is thrown when calling a method on null?", o: ["ReferenceError","SyntaxError","TypeError","NullError"], c: 2 },
    { q: "What is the catch block's parameter such as catch(error)?", o: ["A string message","The line number of the error","The error object with name and message","The type of error only"], c: 2 },
    { q: "What do console.time() and console.timeEnd() measure?", o: ["The current time","How long a block of code takes to execute","Memory usage","Network speed"], c: 1 },
    { q: "What is a RangeError?", o: ["Using a variable out of scope","A number outside the acceptable range (like invalid array length)","Using a string instead of a number","Calling a function with too many arguments"], c: 1 },
    { q: "Can you nest try/catch blocks?", o: ["No, it's not allowed","Yes, a try inside a catch is valid","Only with finally blocks","Only in advanced JavaScript"], c: 1 },
    { q: "What does the Error object contain?", o: ["Only the error message","name, message, and stack properties","Only the line number","Only the function name"], c: 1 },
    { q: "How do you open the browser DevTools console?", o: ["F1","F12 or Ctrl+Shift+I","Ctrl+Alt+J","Right-click and select 'Debug'"], c: 1 },
    { q: "What does console.trace() display?", o: ["A table of data","The current call stack showing how the code reached this point","The execution time","All variables in scope"], c: 1 },
    { q: "What happens if catch never runs in try/catch?", o: ["The program crashes","The code inside catch is ignored and program continues","The finally block doesn't run","An error is forced"], c: 1 },
    { q: "What's the best practice for error handling in functions?", o: ["Let errors crash the app","Try to catch specific error types and handle them appropriately","Never use try/catch","Only use finally blocks"], c: 1 },
    { q: "What does console.assert() do?", o: ["Confirms a variable exists","Tests if a condition is true and logs a message if false","Converts a value to a string","Asserts that an error occurred"], c: 1 },
    { q: "Can you re-throw an error in a catch block?", o: ["No, once caught it's handled","Yes, you can throw it again for outer handlers","Only in specific browsers","Only with finally"], c: 1 },
    { q: "What's the call stack in DevTools used for?", o: ["Storing function return values","Showing the sequence of function calls that led to the current point","Storing global variables","Tracking memory usage"], c: 1 }
]
            }
        ]
    },
    s: {
        title: '&#x2728; S Rank Challenge',
        subtitle: 'Final exam covering every module from both tracks.',
        modules: [
            {
                id: 's1', rank: 'S', num: 1,
                name: 'S Rank Final Exam',
                desc: 'Answer questions drawn from every module in both tracks. 40 challenges await!',
                reviewer: '<p>This is it – the ultimate test. When you start the quiz, you will receive 40 questions covering all HTML and JS modules. Good luck!</p>',
                questions: []
            }
        ]
    }
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€”
//  NAVIGATION
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
        s.style.display = 'none';
    });
    const el = document.getElementById('screen-' + id);
    el.style.display = '';
    el.classList.add('active');
    window.scrollTo({ top: 0, behavior: 'instant' });
}

function goBack(to) {
    if (to === 'main') showScreen('main');
    else if (to === 'track') { showScreen('track'); }
    else if (to === 'reviewer') {
        if (state.currentModule && state.currentModule._isGate) {
            showScreen('track');
        } else {
            renderReviewer(state.currentModule); showScreen('reviewer');
        }
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  TRACK SELECTION
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function selectTrack(trackId) {
    if (trackId === 's') {
        const htmlDone = tracks.html.modules.every(m => state.completed.includes(m.id));
        const jsDone = tracks.js.modules.every(m => state.completed.includes(m.id));
        if (!htmlDone || !jsDone) return;
    }
    state.currentTrack = trackId;
    renderTrack(trackId);
    showScreen('track');
    updateHeaderStats(); // make sure xp/level reflect the newly chosen track
}

function renderTrack(trackId) {
    const track = tracks[trackId];
    document.getElementById('track-title').innerHTML = track.title;
    document.getElementById('track-subtitle').textContent = track.subtitle;

    const container = document.getElementById('modules-container');
    container.innerHTML = '';

    track.modules.forEach((mod, idx) => {
        const isCompleted = state.completed.includes(mod.id);
        const isLocked = state.trackXp[state.currentTrack] < RANK_XP_REQ[mod.rank];

        const row = document.createElement('div');
        row.className = `module-row ${RANK_ROW[mod.rank]} ${isLocked ? 'locked' : ''} ${isCompleted ? 'completed' : ''}`;

        row.innerHTML = `
            <div class="module-rank-pill ${RANK_COLORS[mod.rank]}">${mod.rank}</div>
            <div class="module-info">
                <div class="module-num">Module ${mod.num}</div>
                <div class="module-name">${mod.name}</div>
            </div>
            <div class="module-status">${isCompleted ? '&#x2705;' : isLocked ? '&#x1F512; ' + RANK_XP_REQ[mod.rank] + ' XP' : '&#x27A1;&#xFE0F;'}</div>
        `;

        if (!isLocked) {
            row.onclick = () => {
                const now = Date.now();
                const COOLDOWN = 10 * 60 * 1000; // 10 minutes in ms
                // only trigger gate if random chance passes and cooldown expired
                if (Math.random() < 0.1 && now - (state.lastGateTime || 0) > COOLDOWN) {
                    state.lastGateTime = now;
                    showGate(mod);
                    return;
                }
                openModule(mod);
            };
        }

        container.appendChild(row);
    });
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  MODULE / REVIEWER
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openModule(mod) {
    state.currentModule = mod;
    renderReviewer(mod);
    showScreen('reviewer');
}

function renderReviewer(mod) {
    const rankEl = document.getElementById('reviewer-rank');
    rankEl.textContent = mod.rank + ' RANK';
    rankEl.className = `reviewer-rank-badge ${RANK_COLORS[mod.rank]}`;

    document.getElementById('reviewer-title').textContent = mod.name;
    document.getElementById('reviewer-desc').textContent = mod.desc;
    document.getElementById('reviewer-content').innerHTML = mod.reviewer;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  QUIZ
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function selectRandomQuestions(pool, count) {
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

function startQuiz() {
    const mod = state.currentModule;
    state.quiz = { q: 0, correct: 0, answered: 0, selected: null, questions: [] };

    if (mod.id === 's1') {
        // final S‑rank quiz: gather every question from both tracks
        const allQuestions = [];
        ['html', 'js'].forEach(trackId => {
            tracks[trackId].modules.forEach(m => {
                if (Array.isArray(m.questions)) {
                    m.questions.forEach(q => allQuestions.push(q));
                }
            });
        });
        // shuffle
        for (let i = allQuestions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allQuestions[i], allQuestions[j]] = [allQuestions[j], allQuestions[i]];
        }
        state.quiz.questions = allQuestions.slice(0, 40);
    } else {
        // Select 10 random questions from the question pool
        state.quiz.questions = selectRandomQuestions(mod.questions, 10);
    }
    
    state.isMini = false;
    showScreen('quiz');

    const rankTag = document.getElementById('quiz-rank-tag');
    rankTag.textContent = mod.rank + ' RANK';
    rankTag.className = `quiz-rank-tag ${RANK_COLORS[mod.rank]}`;
    document.getElementById('quiz-title-label').textContent = mod.name;

    loadQuestion();
}

// quick 2–3 question challenge inside the reviewer (SoloLearn style)
function startMiniQuiz() {
    const mod = state.currentModule;
    if (!mod) return;

    state.quiz = { q: 0, correct: 0, answered: 0, selected: null, questions: [] };
    state.quiz.questions = selectRandomQuestions(mod.questions, 5); // now 5-question quick challenge

    state.isMini = true;
    showScreen('quiz');

    document.getElementById('quiz-counter').textContent = 'Mini Challenge';
    document.getElementById('quiz-title-label').textContent = mod.name + ' (quick test)';
    const rankTag = document.getElementById('quiz-rank-tag');
    rankTag.textContent = mod.rank + ' RANK';
    rankTag.className = `quiz-rank-tag ${RANK_COLORS[mod.rank]}`;

    loadQuestion();
}

function loadQuestion() {
    const mod = state.currentModule;
    const q = state.quiz.questions[state.quiz.q];
    const total = state.quiz.questions.length;

    document.getElementById('quiz-counter').textContent = `Question ${state.quiz.q + 1} / ${total}`;
    document.getElementById('quiz-progress-fill').style.width = ((state.quiz.q / total) * 100) + '%';
    document.getElementById('quiz-score-live').innerHTML = `&#x2B50; ${state.quiz.correct}`;
    document.getElementById('quiz-question').innerHTML = q.q;
    const fbEl = document.getElementById('quiz-feedback');
    fbEl.className = 'quiz-feedback hidden';
    fbEl.textContent = '';

    const btn = document.getElementById('quiz-submit');
    btn.disabled = true;
    btn.textContent = 'Submit Answer';
    btn.onclick = submitAnswer;

    state.quiz.selected = null;

    const opts = document.getElementById('quiz-options');
    opts.innerHTML = '';

    if (q.type === 'fill') {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'fill-input';
        inp.placeholder = 'Type your answer...';
        inp.oninput = () => {
            state.quiz.selected = inp.value;
            btn.disabled = inp.value.trim() === '';
        };
        opts.appendChild(inp);
    } else if (q.type === 'code') {
        const ta = document.createElement('textarea');
        ta.className = 'code-challenge';
        ta.value = q.template || '';
        ta.oninput = () => {
            state.quiz.selected = ta.value;
            btn.disabled = ta.value.trim() === '';
        };
        opts.appendChild(ta);
    } else {
        q.o.forEach((opt, i) => {
            const d = document.createElement('div');
            d.className = 'option';
            d.innerHTML = opt;
            d.onclick = () => {
                opts.querySelectorAll('.option').forEach(el => el.classList.remove('selected'));
                d.classList.add('selected');
                state.quiz.selected = i;
                btn.disabled = false;
            };
            opts.appendChild(d);
        });
    }
}

function submitAnswer() {
    const mod = state.currentModule;
    const q = state.quiz.questions[state.quiz.q];
    let correct = false;

    if (q.type === 'fill') {
        const ans = (state.quiz.selected || '').trim().toLowerCase();
        const exp = (q.correct || '').trim().toLowerCase();
        correct = ans === exp;
    } else if (q.type === 'code') {
        const ans = (state.quiz.selected || '').trim();
        const exp = (q.correctCode || '').trim();
        correct = ans === exp;
    } else {
        correct = state.quiz.selected === q.c;
    }

    state.quiz.answered++;
    if (correct) {
        state.quiz.correct++;
        if (!state.isMini) {
            // gate questions reward 30 XP, normal ones 10
            const per = (state.currentModule && state.currentModule._isGate) ? 30 : XP_PER_CORRECT;
            state.trackXp[state.currentTrack] += per;
            state.expStorage[state.currentTrack] += per; // record to EXP storage
        }
    }

    // Style options if MCQ
    if (!q.type || q.type === 'mcq') {
        const opts = document.querySelectorAll('.option');
        opts.forEach((el, i) => {
            el.classList.add('disabled');
            el.onclick = null;
            if (i === q.c) el.classList.add('correct');
            if (i === state.quiz.selected && !correct) el.classList.add('incorrect');
        });
    }

    // Feedback
    const fb = document.getElementById('quiz-feedback');
    fb.className = `quiz-feedback ${correct ? 'correct-fb' : 'incorrect-fb'}`;
    if (correct) {
        if (state.isMini) {
            fb.innerHTML = '&#x2714; Correct! (no XP in quick challenge)';
        } else {
            const per = (state.currentModule && state.currentModule._isGate) ? 30 : XP_PER_CORRECT;
            fb.innerHTML = `&#x2714; Correct! +${per} XP`;
        }
    } else {
        let hint = '';
        if (q.type === 'fill') hint = ` Answer: ${q.correct}`;
        else if (q.type === 'code') hint = ` Correct code:<pre>${q.correctCode}</pre>`;
        fb.innerHTML = `&#x2718; Incorrect. Study the reviewer!${hint}`;
    }
    fb.classList.remove('hidden');

    document.getElementById('quiz-score-live').innerHTML = `&#x2B50; ${state.quiz.correct}`;

    const isLast = state.quiz.q >= state.quiz.questions.length - 1;
    const btn = document.getElementById('quiz-submit');
    btn.disabled = false;
    btn.textContent = isLast ? 'Finish Quiz' : 'Next Question';
    btn.onclick = isLast ? finishQuiz : nextQuestion;

    updateHeaderStats();
    saveProgress();
    saveSession();
    saveSession();
}

function nextQuestion() {
    state.quiz.q++;
    loadQuestion();
}

function finishQuiz() {
    // if the quiz was a mini challenge, just bounce back to reviewer
    if (state.isMini) {
        state.isMini = false;
        showScreen('reviewer');
        return;
    }

    const mod = state.currentModule;
    const score = state.quiz.correct;
    const total = state.quiz.questions.length; // Only the 10 answered questions
    const pct = score / total;

    // Mark completed if passed (>=70%)
    if (pct >= 0.7 && !state.completed.includes(mod.id) && !mod._isGate) {
        state.completed.push(mod.id);
    }

    // Only add XP if passed 70%
    if (pct < 0.7) {
        state.trackXp[state.currentTrack] -= score * XP_PER_CORRECT;
        if (state.trackXp[state.currentTrack] < 0) state.trackXp[state.currentTrack] = 0;
    }

    // Show result
    const xpEarned = score * XP_PER_CORRECT;
    let resultRankText, resultTitle, resultMsg;

    if (pct >= 0.9) { resultRankText = '&#x1F451; S'; resultTitle = 'PERFECT!'; resultMsg = 'Absolutely flawless. You are a true master.'; }
    else if (pct >= 0.8) { resultRankText = '&#x1F525; A'; resultTitle = 'EXCELLENT!'; resultMsg = 'Outstanding performance. Just a little more to perfect!'; }
    else if (pct >= 0.7) { resultRankText = '&#x1F4AA; B'; resultTitle = 'GREAT JOB!'; resultMsg = 'Solid work. Keep pushing forward!'; }
    else if (pct >= 0.6) { resultRankText = '&#x1F44D; C'; resultTitle = 'PASSED!'; resultMsg = 'You cleared the module. Review to improve your score!'; }
    else { resultRankText = '&#x1F4D6; F'; resultTitle = 'TRY AGAIN'; resultMsg = 'Review the material and come back stronger!'; }

    document.getElementById('result-rank-icon').innerHTML = resultRankText;
    document.getElementById('result-title').textContent = resultTitle;
    document.getElementById('result-msg').textContent = resultMsg;
    document.getElementById('res-score').textContent = `${score}/${total}`;
    document.getElementById('res-xp').textContent = `+${xpEarned}`;
    document.getElementById('res-rank').innerHTML = resultRankText;

    updateHeaderStats();
    updateTrackProgress();
    checkSRankUnlock();
    saveProgress();
    showScreen('result');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  UI UPDATES
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function updateHeaderStats() {
    // determine which XP value to show: total on main, track-specific when in a track
    let currentXp;
    if (state.currentTrack) {
        currentXp = state.expStorage[state.currentTrack] || 0;
    } else {
        currentXp = (state.expStorage.html || 0) + (state.expStorage.js || 0);
    }
    document.getElementById('xp').textContent = currentXp;
    document.getElementById('level').textContent = Math.floor(currentXp / 100) + 1;
    document.getElementById('completedCount').textContent = state.completed.length;

    // track-specific EXP elements should only appear when a track is active
    const expHtmlEl = document.getElementById('exp-html');
    const expJsEl   = document.getElementById('exp-js');
    if (expHtmlEl && expJsEl) {
        if (state.currentTrack === 'html') {
            expHtmlEl.parentElement.style.display = 'flex';
            expJsEl.parentElement.style.display = 'none';
            expHtmlEl.textContent = state.expStorage.html;
        } else if (state.currentTrack === 'js') {
            expHtmlEl.parentElement.style.display = 'none';
            expJsEl.parentElement.style.display = 'flex';
            expJsEl.textContent = state.expStorage.js;
        } else {
            expHtmlEl.parentElement.style.display = 'none';
            expJsEl.parentElement.style.display = 'none';
        }
    }
}

function updateTrackProgress() {
    const htmlDone = tracks.html.modules.filter(m => state.completed.includes(m.id)).length;
    const jsDone = tracks.js.modules.filter(m => state.completed.includes(m.id)).length;
    document.getElementById('html-progress').style.width = ((htmlDone / 6) * 100) + '%';
    document.getElementById('js-progress').style.width = ((jsDone / 6) * 100) + '%';
    saveSession();
    saveProgress(); // ensure cloud copy stays current
}

function checkSRankUnlock() {
    const htmlDone = tracks.html.modules.every(m => state.completed.includes(m.id));
    const jsDone = tracks.js.modules.every(m => state.completed.includes(m.id));
    const sCard = document.getElementById('btn-s-track');
    if (htmlDone && jsDone) {
        sCard.classList.remove('locked');
        sCard.querySelector('.track-modules').textContent = '&#x1F513; Unlocked!';
    }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  SANDBOX
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openSandbox() {
    showScreen('sandbox');
    // Set starter template
    if (!document.getElementById('sandbox-html').value) {
        document.getElementById('sandbox-html').value = `<!DOCTYPE html>
<html>
<head>
  <title>Sandbox</title>
</head>
<body>
  <h1>Hello, World!</h1>
  <p>Start coding here...</p>
</body>
</html>`;
        document.getElementById('sandbox-css').value = `body {
  font-family: sans-serif;
  padding: 20px;
  background: #f0f4ff;
}
h1 { color: #7c3aed; }`;
        document.getElementById('sandbox-js').value = `// Your JavaScript here
console.log("Sandbox ready!");`;
        runSandbox();
    }
}

function runSandbox() {
    // sandbox modifications change state? not really but safe to persist
    saveSession();
    saveProgress();
    const html = document.getElementById('sandbox-html').value;
    const css = document.getElementById('sandbox-css').value;
    const js = document.getElementById('sandbox-js').value;

    const combined = `
<!DOCTYPE html>
<html>
<head>
<style>${css}</style>
</head>
<body>
${html.replace(/<!DOCTYPE html>[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '')}
<script>
try { ${js} } catch(e) { document.body.innerHTML += '<div style="color:red;padding:10px;border:1px solid red;margin:10px;border-radius:5px;font-family:monospace;">JS Error: '+e.message+'</div>'; }
<\/script>
</body>
</html>`;

    const iframe = document.getElementById('sandbox-iframe');
    iframe.srcdoc = combined;
}

// Run sandbox on Ctrl+Enter
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (document.getElementById('screen-sandbox').classList.contains('active')) {
            runSandbox();
        }
    }
});

// persist state on unload (refresh/close) so the cloud copy is up to date
window.addEventListener('beforeunload', () => {
    saveSession();
    saveProgress();
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  GATE
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let pendingMod = null;
// timestamp (ms) of last gate appearance, used to enforce 10‑minute cooldown
state.lastGateTime = 0;

function showGate(mod) {
    pendingMod = mod;
    document.getElementById('gateOverlay').style.display = 'flex';
    document.getElementById('gateAnimation').style.display = 'block';
    document.getElementById('gateModal').classList.add('hidden');
    setTimeout(() => {
        document.getElementById('gateAnimation').style.display = 'none';
        document.getElementById('gateModal').classList.remove('hidden');
    }, 2000);
}

function enterGate() {
    document.getElementById('gateOverlay').style.display = 'none';
    if (pendingMod) {
        // award a hefty 100 XP bonus to both tracks no matter which one triggered the gate
        // gate bonus: 100 XP to both tracks
        state.trackXp.html += 100;
        state.trackXp.js  += 100;
        // also add to the EXP storage for both tracks
        state.expStorage.html += 100;
        state.expStorage.js  += 100;
        updateHeaderStats();
        updateTrackProgress(); // in case the bonus unlocked modules on the other track
        saveProgress();
        launchGateQuiz(pendingMod);
        pendingMod = null;
    }
}

function declineGate() {
    document.getElementById('gateOverlay').style.display = 'none';
    const mod = pendingMod;
    pendingMod = null;
    if (mod) { openModule(mod); }
}

function launchGateQuiz(originMod) {
    const allQuestions = [];
    ['html', 'js'].forEach(trackId => {
        tracks[trackId].modules.forEach(mod => {
            mod.questions.forEach(q => {
                allQuestions.push({ ...q, _modName: mod.name, _rank: mod.rank });
            });
        });
    });

    // shuffle pool in place
    for (let i = allQuestions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allQuestions[i], allQuestions[j]] = [allQuestions[j], allQuestions[i]];
    }
    const gateQuestions = allQuestions.slice(0, 10);

    const gateMod = {
        id: '__gate__',
        rank: 'S',
        num: '&#x26A1;',
        name: '&#x26A1; Gate Challenge',
        desc: 'A special 10-question challenge drawn from all modules!',
        questions: gateQuestions,
        reviewer: '<p>Gate challenge completed!</p>',
        _isGate: true,
        _originMod: originMod
    };

    state.currentModule = gateMod;
    state.quiz = { q: 0, correct: 0, answered: 0, selected: null, questions: gateQuestions };

    const rankTag = document.getElementById('quiz-rank-tag');
    rankTag.innerHTML = '&#x26A1; GATE';
    rankTag.className = 'quiz-rank-tag rank-s';
    document.getElementById('quiz-title-label').innerHTML = '&#x26A1; Gate Challenge &mdash; 10 Random Questions';

    showScreen('quiz');
    loadQuestion();
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  INIT
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
updateHeaderStats();
updateTrackProgress();
// Expose functions to global scope (required because this file is a module)
window.login = login;
window.register = register;
window.logout = logout;
window.selectTrack = selectTrack;
window.openModule = openModule;
window.startQuiz = startQuiz;
window.startMiniQuiz = startMiniQuiz;
window.submitAnswer = submitAnswer;
window.nextQuestion = nextQuestion;
window.finishQuiz = finishQuiz;
window.goBack = goBack;
window.openSandbox = openSandbox;
window.runSandbox = runSandbox;
window.enterGate = enterGate;
window.declineGate = declineGate;