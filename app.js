(function() {
  'use strict';

  // --- State ---
  const state = {
    reportData: {},
    yontakuQuestions: [],
    marubatsuQuestions: [],
    currentQuiz: null,
    pageHistory: ['top-page'],
    dataLoaded: false
  };

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // --- Storage ---
  const STORAGE_PREFIX = 'gakushu_';

  function getWrongAnswers(type) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + type + '_wrong');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveWrongAnswers(type, data) {
    try {
      localStorage.setItem(STORAGE_PREFIX + type + '_wrong', JSON.stringify(data));
    } catch { /* storage full */ }
  }

  function addWrongAnswer(type, question) {
    const data = getWrongAnswers(type);
    const key = question.id || question.question;
    if (data[key]) {
      data[key].count += 1;
    } else {
      data[key] = {
        question: question.question,
        answer: question.answer,
        explanation: question.explanation || '',
        category: question.category,
        choices: question.choices || null,
        count: 1
      };
    }
    saveWrongAnswers(type, data);
  }

  function clearWrongAnswers(type) {
    localStorage.removeItem(STORAGE_PREFIX + type + '_wrong');
  }

  // --- Markdown parsing: Report ---
  function parseReport(md) {
    const sections = {};
    const sectionRegex = /^## (.+)$/gm;
    let match;
    const positions = [];

    while ((match = sectionRegex.exec(md)) !== null) {
      positions.push({ name: match[1].trim(), start: match.index + match[0].length });
    }

    for (let i = 0; i < positions.length; i++) {
      const end = i + 1 < positions.length ? positions[i + 1].start - positions[i + 1].name.length - 4 : md.length;
      sections[positions[i].name] = md.substring(positions[i].start, end).trim();
    }

    return sections;
  }

  // --- Markdown parsing: 問題集 ---
  function parseQuestions(md) {
    const questions = [];
    let currentCategory = '';

    // Split by ## to get category sections
    const categorySections = md.split(/^## /gm).filter(s => s.trim());

    for (const section of categorySections) {
      const lines = section.split('\n');
      const categoryName = lines[0].trim();

      // Skip the top-level title line and separator lines
      if (categoryName === '問題集' || categoryName.startsWith('---') || categoryName.startsWith('>')) continue;

      currentCategory = categoryName;

      // Split by ### 問題N to get individual questions
      const questionBlocks = section.split(/^### 問題\d+\s*$/gm).filter(b => b.trim());

      // Skip first block (it's just the category header)
      for (let i = 1; i < questionBlocks.length; i++) {
        const block = questionBlocks[i];
        const q = parseQuestionBlock(block, currentCategory);
        if (q) {
          q.id = 'yt_' + questions.length;
          questions.push(q);
        }
      }
    }

    return questions;
  }

  function parseQuestionBlock(block, category) {
    const lines = block.split('\n').map(l => l.trim()).filter(l => l);
    const q = { category: category, choices: {} };

    const questionLines = [];
    let foundChoice = false;

    for (const line of lines) {
      // Skip separator lines
      if (line.startsWith('---') || line.startsWith('>')) continue;

      // Answer line
      if (line.startsWith('answer:') || line.startsWith('answer：')) {
        q.answer = line.replace(/^answer[:：]\s*/, '').trim();
        continue;
      }

      // Explanation line
      if (line.startsWith('explanation:') || line.startsWith('explanation：')) {
        q.explanation = line.replace(/^explanation[:：]\s*/, '').trim();
        continue;
      }

      // Choice lines: - A: text
      const choiceMatch = line.match(/^- ([A-D])[:：]\s*(.+)/);
      if (choiceMatch) {
        foundChoice = true;
        q.choices[choiceMatch[1]] = choiceMatch[2].trim();
        continue;
      }

      // Question text (lines before choices)
      if (!foundChoice && line !== category) {
        questionLines.push(line);
      }
    }

    q.question = questionLines.join(' ').trim();

    if (!q.question || !q.answer || Object.keys(q.choices).length === 0) return null;
    return q;
  }

  // --- Generate ○× questions from 4択 questions ---
  function generateMarubatsu(yontakuQuestions) {
    const marubatsu = [];

    for (const q of yontakuQuestions) {
      if (!q.choices || !q.answer) continue;

      // Create ○ question (correct statement)
      const correctText = q.choices[q.answer];
      if (correctText) {
        marubatsu.push({
          id: 'mb_t_' + marubatsu.length,
          category: q.category,
          question: q.question + '\n→ ' + correctText,
          answer: '○',
          explanation: '正解の選択肢です。（元の4択問題の正解: ' + q.answer + '）'
        });
      }

      // Create × question (incorrect statement) — pick a random wrong choice
      const wrongKeys = Object.keys(q.choices).filter(k => k !== q.answer);
      if (wrongKeys.length > 0) {
        const wrongKey = wrongKeys[Math.floor(Math.random() * wrongKeys.length)];
        const wrongText = q.choices[wrongKey];
        marubatsu.push({
          id: 'mb_f_' + marubatsu.length,
          category: q.category,
          question: q.question + '\n→ ' + wrongText,
          answer: '×',
          explanation: '正しくは「' + correctText + '」です。（正解: ' + q.answer + '）'
        });
      }
    }

    return marubatsu;
  }

  // --- Simple markdown to HTML ---
  function mdToHtml(md) {
    let html = '';
    const lines = md.split('\n');
    let inList = false;
    let inOrderedList = false;
    let inTable = false;
    let tableRows = [];
    let orderedIndex = 0;

    function flushTable() {
      if (!inTable) return;
      inTable = false;
      if (tableRows.length < 2) return;
      let t = '<div class="table-wrap"><table><thead><tr>';
      const headers = tableRows[0].split('|').map(c => c.trim()).filter(c => c);
      for (const h of headers) t += '<th>' + esc(h) + '</th>';
      t += '</tr></thead><tbody>';
      for (let i = 2; i < tableRows.length; i++) {
        const cells = tableRows[i].split('|').map(c => c.trim()).filter(c => c);
        t += '<tr>';
        for (const c of cells) t += '<td>' + formatInline(c) + '</td>';
        t += '</tr>';
      }
      t += '</tbody></table></div>';
      html += t;
      tableRows = [];
    }

    function flushLists() {
      if (inList) { html += '</ul>'; inList = false; }
      if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
    }

    for (const line of lines) {
      // Table detection
      if (line.includes('|') && !line.startsWith('- ') && !line.startsWith('* ')) {
        flushLists();
        inTable = true;
        tableRows.push(line);
        continue;
      }

      if (inTable && !line.includes('|')) {
        flushTable();
      }
      if (inTable) {
        tableRows.push(line);
        continue;
      }

      // Headings
      if (line.startsWith('#### ')) {
        flushLists();
        html += '<h4>' + formatInline(line.substring(5)) + '</h4>';
        continue;
      }
      if (line.startsWith('### ')) {
        flushLists();
        html += '<h3>' + formatInline(line.substring(4)) + '</h3>';
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^(\d+)\.\s+(.+)/);
      if (olMatch) {
        if (inList) { html += '</ul>'; inList = false; }
        if (!inOrderedList) { html += '<ol>'; inOrderedList = true; }
        html += '<li>' + formatInline(olMatch[2]) + '</li>';
        continue;
      }

      // Unordered list
      if (line.startsWith('- ') || line.startsWith('* ')) {
        if (inOrderedList) { html += '</ol>'; inOrderedList = false; }
        if (!inList) { html += '<ul>'; inList = true; }
        // Handle indented sub-items
        const content = line.replace(/^[-*]\s+/, '');
        html += '<li>' + formatInline(content) + '</li>';
        continue;
      }

      // Indented list continuation
      if ((inList || inOrderedList) && line.startsWith('  ')) {
        const content = line.trim();
        if (content.startsWith('- ') || content.startsWith('* ')) {
          html += '<li class="sub-item">' + formatInline(content.substring(2)) + '</li>';
        } else {
          // Continuation of previous item
          html += '<li class="sub-item">' + formatInline(content) + '</li>';
        }
        continue;
      }

      // Empty line
      if (!line.trim()) {
        flushLists();
        continue;
      }

      // Blockquote
      if (line.startsWith('> ')) {
        flushLists();
        html += '<blockquote>' + formatInline(line.substring(2)) + '</blockquote>';
        continue;
      }

      // Paragraph
      flushLists();
      html += '<p>' + formatInline(line) + '</p>';
    }

    flushLists();
    flushTable();
    return html;
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function formatInline(s) {
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`(.+?)`/g, '<code>$1</code>');
    return s;
  }

  // --- Data loading ---
  async function loadData() {
    try {
      const [reportRes, questionRes] = await Promise.all([
        fetch('レポート.md'),
        fetch('問題集.md')
      ]);

      if (reportRes.ok) {
        const reportMd = await reportRes.text();
        state.reportData = parseReport(reportMd);
      }

      if (questionRes.ok) {
        const questionMd = await questionRes.text();
        state.yontakuQuestions = parseQuestions(questionMd);
        state.marubatsuQuestions = generateMarubatsu(state.yontakuQuestions);
      }

      state.dataLoaded = true;
      updateDataStatus();
    } catch (e) {
      console.error('Data load error:', e);
    }
  }

  function updateDataStatus() {
    const yt = state.yontakuQuestions.length;
    const mb = state.marubatsuQuestions.length;
    const rpt = Object.keys(state.reportData).length;

    if (rpt > 0) {
      const badge = $('#report-badge');
      if (badge) badge.textContent = rpt + ' sections';
    }
  }

  // --- Navigation ---
  function showPage(pageId, title) {
    $$('.page').forEach(p => p.classList.remove('active'));
    const page = $('#' + pageId);
    if (page) page.classList.add('active');

    if (title) $('#header-title').textContent = title;

    const isTop = pageId === 'top-page';
    $('#back-btn').classList.toggle('hidden', isTop);

    if (!isTop && state.pageHistory[state.pageHistory.length - 1] !== pageId) {
      state.pageHistory.push(pageId);
    }

    // Scroll to top
    window.scrollTo(0, 0);
  }

  function goBack() {
    state.pageHistory.pop();
    const prev = state.pageHistory[state.pageHistory.length - 1] || 'top-page';
    const titles = {
      'top-page': '学習アプリ',
      'report-page': 'レポート',
      'marubatsu-page': '○×テスト',
      'yontaku-page': '4択問題'
    };
    showPage(prev, titles[prev] || '学習アプリ');

    if (prev === 'marubatsu-page') {
      showMarubatsuStats();
      renderCategoryButtons('marubatsu-categories', state.marubatsuQuestions, startMarubatsu, 'marubatsu');
    }
    if (prev === 'yontaku-page') {
      showYontakuStats();
      renderCategoryButtons('yontaku-categories', state.yontakuQuestions, startYontaku, 'yontaku');
    }
  }

  // --- Report ---
  function showReport(section) {
    const content = state.reportData[section];
    if (!content) {
      $('#report-content').innerHTML = '<p class="empty-message">データが見つかりません</p>';
    } else {
      $('#report-content').innerHTML = mdToHtml(content);
    }
    showPage('report-content-page', section);
  }

  // --- Category Selection ---
  function getCategories(questions) {
    const cats = [];
    const seen = {};
    for (const q of questions) {
      if (q.category && !seen[q.category]) {
        seen[q.category] = true;
        cats.push(q.category);
      }
    }
    return cats;
  }

  function renderCategoryButtons(containerId, questions, startFn, type) {
    const container = $('#' + containerId);
    if (!container) return;
    container.innerHTML = '';

    // "全ジャンル" button
    const allBtn = document.createElement('button');
    allBtn.className = 'category-btn all-category';
    allBtn.innerHTML = '<span class="cat-icon">🎯</span><span class="cat-label">全ジャンル</span><span class="cat-count">' + questions.length + '問からランダム20問</span>';
    allBtn.addEventListener('click', () => startFn(questions));
    container.appendChild(allBtn);

    // Per-category buttons
    const categories = getCategories(questions);
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const catQuestions = questions.filter(q => q.category === cat);
      const btn = document.createElement('button');
      btn.className = 'category-btn';
      const qCount = catQuestions.length;
      const displayCount = qCount < 20 ? qCount + '問すべて出題' : '20問出題';
      btn.innerHTML = '<span class="cat-num">' + String(i + 1).padStart(2, '0') + '</span><span class="cat-label">' + esc(cat) + '</span><span class="cat-count">' + qCount + '問中' + displayCount + '</span>';
      btn.addEventListener('click', () => startFn(catQuestions));
      container.appendChild(btn);
    }
  }

  // --- ○× Test ---
  function startMarubatsu(questions) {
    if (questions.length === 0) {
      alert('問題データがありません。');
      return;
    }
    const shuffled = shuffle([...questions]).slice(0, 20);
    state.currentQuiz = {
      type: 'marubatsu',
      questions: shuffled,
      index: 0,
      correct: 0,
      wrong: []
    };
    showMarubatsuQuestion();
    showPage('marubatsu-quiz-page', '○×テスト');
  }

  function showMarubatsuQuestion() {
    const quiz = state.currentQuiz;
    const q = quiz.questions[quiz.index];
    const total = quiz.questions.length;

    $('#marubatsu-progress-text').textContent = '問題 ' + (quiz.index + 1) + ' / ' + total;
    $('#marubatsu-progress-bar').style.width = ((quiz.index + 1) / total * 100) + '%';
    $('#marubatsu-category').textContent = q.category || '';

    // Render question with line breaks
    const questionEl = $('#marubatsu-question');
    questionEl.innerHTML = '';
    const parts = q.question.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const arrow = document.createElement('div');
        arrow.className = 'question-statement';
        arrow.textContent = parts[i];
        questionEl.appendChild(arrow);
      } else {
        const text = document.createElement('div');
        text.textContent = parts[i];
        questionEl.appendChild(text);
      }
    }

    // Reset
    $('#marubatsu-result').classList.add('hidden');
    $('#marubatsu-next').classList.add('hidden');
    $$('.marubatsu-buttons .answer-btn').forEach(btn => {
      btn.disabled = false;
      btn.className = 'answer-btn ' + (btn.dataset.answer === '○' ? 'maru-btn' : 'batsu-btn');
    });
  }

  function answerMarubatsu(selected) {
    const quiz = state.currentQuiz;
    const q = quiz.questions[quiz.index];
    const isCorrect = selected === q.answer;

    $$('.marubatsu-buttons .answer-btn').forEach(btn => {
      btn.disabled = true;
      if (btn.dataset.answer === q.answer) {
        btn.classList.add('correct');
      } else if (btn.dataset.answer === selected && !isCorrect) {
        btn.classList.add('incorrect');
      }
    });

    const resultEl = $('#marubatsu-result');
    resultEl.classList.remove('hidden', 'correct-result', 'incorrect-result');

    if (isCorrect) {
      quiz.correct++;
      resultEl.classList.add('correct-result');
      resultEl.innerHTML = '<div class="result-label">正解!</div>';
    } else {
      quiz.wrong.push(q);
      addWrongAnswer('marubatsu', q);
      resultEl.classList.add('incorrect-result');
      resultEl.innerHTML =
        '<div class="result-label">不正解</div>' +
        '<div class="result-answer">正解: ' + esc(q.answer) + '</div>' +
        '<div class="result-explanation">' + esc(q.explanation || '') + '</div>';
    }

    $('#marubatsu-next').classList.remove('hidden');
    $('#marubatsu-next').textContent = quiz.index + 1 < quiz.questions.length ? '次の問題' : '結果を見る';
  }

  function nextMarubatsu() {
    const quiz = state.currentQuiz;
    quiz.index++;
    if (quiz.index < quiz.questions.length) {
      showMarubatsuQuestion();
    } else {
      showFinalResult('marubatsu');
    }
  }

  // --- 4択 Test ---
  function startYontaku(questions) {
    if (questions.length === 0) {
      alert('問題データがありません。');
      return;
    }
    const shuffled = shuffle([...questions]).slice(0, 20);
    state.currentQuiz = {
      type: 'yontaku',
      questions: shuffled,
      index: 0,
      correct: 0,
      wrong: []
    };
    showYontakuQuestion();
    showPage('yontaku-quiz-page', '4択問題');
  }

  function showYontakuQuestion() {
    const quiz = state.currentQuiz;
    const q = quiz.questions[quiz.index];
    const total = quiz.questions.length;

    $('#yontaku-progress-text').textContent = '問題 ' + (quiz.index + 1) + ' / ' + total;
    $('#yontaku-progress-bar').style.width = ((quiz.index + 1) / total * 100) + '%';
    $('#yontaku-category').textContent = q.category || '';
    $('#yontaku-question').textContent = q.question;

    // Reset
    $('#yontaku-result').classList.add('hidden');
    $('#yontaku-next').classList.add('hidden');

    const choicesEl = $('#yontaku-choices');
    choicesEl.innerHTML = '';

    if (q.choices) {
      const letters = Object.keys(q.choices).sort();
      for (const letter of letters) {
        const btn = document.createElement('button');
        btn.className = 'choice-btn';
        btn.dataset.letter = letter;

        const letterSpan = document.createElement('span');
        letterSpan.className = 'choice-letter';
        letterSpan.textContent = letter;

        const textSpan = document.createElement('span');
        textSpan.className = 'choice-text';
        textSpan.textContent = q.choices[letter];

        btn.appendChild(letterSpan);
        btn.appendChild(textSpan);
        btn.addEventListener('click', () => answerYontaku(letter));
        choicesEl.appendChild(btn);
      }
    }
  }

  function answerYontaku(selected) {
    const quiz = state.currentQuiz;
    const q = quiz.questions[quiz.index];
    const isCorrect = selected === q.answer;

    $$('.choice-btn').forEach(btn => {
      btn.disabled = true;
      if (btn.dataset.letter === q.answer) {
        btn.classList.add('correct');
      } else if (btn.dataset.letter === selected && !isCorrect) {
        btn.classList.add('incorrect');
      }
    });

    const resultEl = $('#yontaku-result');
    resultEl.classList.remove('hidden', 'correct-result', 'incorrect-result');

    if (isCorrect) {
      quiz.correct++;
      resultEl.classList.add('correct-result');
      resultEl.innerHTML = '<div class="result-label">正解!</div>';
    } else {
      quiz.wrong.push(q);
      addWrongAnswer('yontaku', q);
      const correctText = q.choices ? q.choices[q.answer] : q.answer;
      resultEl.classList.add('incorrect-result');
      resultEl.innerHTML =
        '<div class="result-label">不正解</div>' +
        '<div class="result-answer">正解: ' + esc(q.answer) + ' - ' + esc(correctText || '') + '</div>' +
        (q.explanation ? '<div class="result-explanation">' + esc(q.explanation) + '</div>' : '');
    }

    $('#yontaku-next').classList.remove('hidden');
    $('#yontaku-next').textContent = quiz.index + 1 < quiz.questions.length ? '次の問題' : '結果を見る';
  }

  function nextYontaku() {
    const quiz = state.currentQuiz;
    quiz.index++;
    if (quiz.index < quiz.questions.length) {
      showYontakuQuestion();
    } else {
      showFinalResult('yontaku');
    }
  }

  // --- Final Result (shared) ---
  function showFinalResult(type) {
    const quiz = state.currentQuiz;
    const total = quiz.questions.length;
    const pct = Math.round(quiz.correct / total * 100);
    const pageId = type + '-result-page';
    const containerId = type === 'marubatsu' ? 'marubatsu-final-result' : 'yontaku-final-result';

    let emoji = '🎉';
    let message = '素晴らしい！';
    if (pct < 50) { emoji = '📚'; message = 'もう少し頑張りましょう'; }
    else if (pct < 80) { emoji = '👍'; message = 'いい調子です！'; }

    let html =
      '<div class="result-summary">' +
        '<div class="result-emoji">' + emoji + '</div>' +
        '<div class="result-label-text">正答率</div>' +
        '<div class="result-score">' + pct + '%</div>' +
        '<div class="result-detail">' + quiz.correct + ' / ' + total + ' 問正解</div>' +
        '<div class="result-message">' + message + '</div>' +
      '</div>';

    if (quiz.wrong.length > 0) {
      html += '<div class="result-breakdown"><h3>間違えた問題</h3>';
      for (const q of quiz.wrong) {
        const answerText = type === 'yontaku' && q.choices
          ? esc(q.answer) + ' - ' + esc(q.choices[q.answer] || '')
          : esc(q.answer);
        html +=
          '<div class="wrong-item">' +
            '<div class="wrong-q">' + esc(q.question.split('\n')[0]) + '</div>' +
            '<div class="wrong-a">正解: ' + answerText + '</div>' +
          '</div>';
      }
      html += '</div>';
    }

    html +=
      '<div class="result-actions">' +
        '<button class="action-btn primary" id="' + type + '-retry">もう一度チャレンジ</button>' +
        '<button class="action-btn secondary" id="' + type + '-back-top">トップに戻る</button>' +
      '</div>';

    $('#' + containerId).innerHTML = html;
    showPage(pageId, '結果');

    $('#' + type + '-retry').addEventListener('click', () => {
      if (type === 'marubatsu') {
        showMarubatsuStats();
        renderCategoryButtons('marubatsu-categories', state.marubatsuQuestions, startMarubatsu, 'marubatsu');
        state.pageHistory = ['top-page', 'marubatsu-page'];
        showPage('marubatsu-page', '○×テスト');
      } else {
        showYontakuStats();
        renderCategoryButtons('yontaku-categories', state.yontakuQuestions, startYontaku, 'yontaku');
        state.pageHistory = ['top-page', 'yontaku-page'];
        showPage('yontaku-page', '4択問題');
      }
    });
    $('#' + type + '-back-top').addEventListener('click', () => {
      state.pageHistory = ['top-page'];
      showPage('top-page', '学習アプリ');
    });
  }

  // --- Stats ---
  function showStats(type, containerId) {
    const wrong = getWrongAnswers(type);
    const entries = Object.values(wrong);
    const el = $('#' + containerId);

    if (entries.length === 0) {
      el.innerHTML = '<div class="stats-empty">まだ間違い記録はありません</div>';
      return;
    }

    const byCategory = {};
    let totalErrors = 0;
    for (const e of entries) {
      const cat = e.category || '不明';
      if (!byCategory[cat]) byCategory[cat] = 0;
      byCategory[cat] += e.count;
      totalErrors += e.count;
    }

    let html = '<div class="stats-card"><h3>間違い統計 <span class="stats-total">合計 ' + totalErrors + '回</span></h3>';
    const sortedCategories = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
    for (const [cat, count] of sortedCategories) {
      const barWidth = Math.round(count / totalErrors * 100);
      html +=
        '<div class="stats-row">' +
          '<span class="stats-cat">' + esc(cat) + '</span>' +
          '<div class="stats-bar-wrap"><div class="stats-bar" style="width:' + barWidth + '%"></div></div>' +
          '<span class="stats-count">' + count + '回</span>' +
        '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function showMarubatsuStats() { showStats('marubatsu', 'marubatsu-stats'); }
  function showYontakuStats() { showStats('yontaku', 'yontaku-stats'); }

  // --- Review Mode ---
  function showReview(type) {
    const wrong = getWrongAnswers(type);
    const entries = Object.values(wrong);
    const label = type === 'marubatsu' ? '○×テスト' : '4択問題';

    if (entries.length === 0) {
      $('#review-content').innerHTML = '<div class="review-empty"><div class="review-empty-icon">✨</div><div>間違えた問題はありません</div></div>';
      showPage('review-page', label + ' 復習');
      return;
    }

    // Group by category
    const byCategory = {};
    for (const e of entries) {
      const cat = e.category || '不明';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(e);
    }

    let html = '';
    for (const [cat, items] of Object.entries(byCategory)) {
      const totalCount = items.reduce((s, i) => s + i.count, 0);
      html +=
        '<div class="review-category">' +
          '<div class="review-category-header">' +
            '<span class="review-category-name">' + esc(cat) + '</span>' +
            '<span class="review-category-count">' + totalCount + '回間違い</span>' +
          '</div>' +
          '<div class="review-items">';

      items.sort((a, b) => b.count - a.count);
      for (const item of items) {
        const answerText = item.choices && item.choices[item.answer]
          ? esc(item.answer) + ' - ' + esc(item.choices[item.answer])
          : esc(item.answer);
        html +=
          '<div class="review-item">' +
            '<div class="review-q">' + esc(item.question.split('\n')[0]) + '</div>' +
            '<div class="review-a">正解: ' + answerText + '</div>' +
            (item.explanation ? '<div class="review-explanation">' + esc(item.explanation) + '</div>' : '') +
            '<div class="review-error-count">' + item.count + '回間違い</div>' +
          '</div>';
      }
      html += '</div></div>';
    }

    html +=
      '<div class="review-actions">' +
        '<button class="clear-btn" id="clear-review-' + type + '">間違い記録をリセット</button>' +
      '</div>';

    $('#review-content').innerHTML = html;
    showPage('review-page', label + ' 復習');

    $('#clear-review-' + type).addEventListener('click', () => {
      if (confirm('間違い記録をリセットしますか？')) {
        clearWrongAnswers(type);
        $('#review-content').innerHTML = '<div class="review-empty"><div class="review-empty-icon">✨</div><div>間違えた問題はありません</div></div>';
      }
    });
  }

  // --- Utility ---
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // --- Event Listeners ---
  function init() {
    // Back button
    $('#back-btn').addEventListener('click', goBack);

    // Top page buttons
    $$('.main-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        if (page === 'report') {
          showPage('report-page', 'レポート');
        } else if (page === 'marubatsu') {
          showMarubatsuStats();
          renderCategoryButtons('marubatsu-categories', state.marubatsuQuestions, startMarubatsu, 'marubatsu');
          showPage('marubatsu-page', '○×テスト');
        } else if (page === 'yontaku') {
          showYontakuStats();
          renderCategoryButtons('yontaku-categories', state.yontakuQuestions, startYontaku, 'yontaku');
          showPage('yontaku-page', '4択問題');
        }
      });
    });

    // Report section buttons
    $$('.sub-btn[data-section]').forEach(btn => {
      btn.addEventListener('click', () => showReport(btn.dataset.section));
    });

    // ○× review
    $('#marubatsu-review').addEventListener('click', () => showReview('marubatsu'));

    // ○× answer buttons
    $$('.marubatsu-buttons .answer-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!btn.disabled) answerMarubatsu(btn.dataset.answer);
      });
    });
    $('#marubatsu-next').addEventListener('click', nextMarubatsu);

    // 4択 review
    $('#yontaku-review').addEventListener('click', () => showReview('yontaku'));
    $('#yontaku-next').addEventListener('click', nextYontaku);

    // Load data
    loadData();
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
