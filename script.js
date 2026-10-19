const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('.primary-nav');

menuButton.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!isOpen));
  menuButton.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
  navigation.classList.toggle('is-open', !isOpen);
  document.body.classList.toggle('menu-open', !isOpen);
});

navigation.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-label', 'Open navigation');
  navigation.classList.remove('is-open');
  document.body.classList.remove('menu-open');
}));

document.querySelector('#year').textContent = new Date().getFullYear();

const generatorForm = document.querySelector('#generator-form');
const generatorPrompt = document.querySelector('#generator-prompt');
const generatorCount = document.querySelector('#generator-count');
const generatorSubmit = document.querySelector('#generator-submit');
const generatorStatus = document.querySelector('#generator-status');
const generatorResult = document.querySelector('#generator-result');
const generatorOutput = document.querySelector('#generator-output');

generatorPrompt.addEventListener('input', () => {
  generatorCount.textContent = `${generatorPrompt.value.length} / 2000`;
});

generatorPrompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    generatorForm.requestSubmit();
  }
});

generatorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = generatorPrompt.value.trim();
  if (prompt.length < 10 || prompt.length > 2000) {
    generatorStatus.textContent = 'Please enter a brief between 10 and 2,000 characters.';
    generatorPrompt.focus();
    return;
  }

  generatorSubmit.disabled = true;
  generatorSubmit.setAttribute('aria-busy', 'true');
  generatorSubmit.innerHTML = '<span class="loading-dot" aria-hidden="true"></span> Creating draft…';
  generatorStatus.textContent = 'Creating your draft with Gemini…';
  generatorResult.hidden = true;

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: document.querySelector('#generator-type').value, prompt }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'We could not create a draft. Please try again.');
    if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('The AI service returned an empty draft. Please try again.');
    generatorOutput.textContent = data.text;
    generatorResult.hidden = false;
    generatorStatus.textContent = 'Your draft is ready. Review it and make it your own.';
  } catch (error) {
    generatorStatus.textContent = error instanceof TypeError
      ? 'Could not reach the website server. Start it with npm start, then refresh this page.'
      : error.message;
  } finally {
    generatorSubmit.disabled = false;
    generatorSubmit.removeAttribute('aria-busy');
    generatorSubmit.innerHTML = 'Generate with AI <span aria-hidden="true">↗</span>';
  }
});

document.querySelector('#generator-copy').addEventListener('click', async (event) => {
  try {
    await navigator.clipboard.writeText(generatorOutput.textContent);
    event.currentTarget.textContent = 'Copied';
    window.setTimeout(() => { event.currentTarget.textContent = 'Copy'; }, 1600);
  } catch {
    generatorStatus.textContent = 'Copy is unavailable in this browser. Select the draft text to copy it.';
  }
});

if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const revealItems = document.querySelectorAll('.platform-panel, .capability-card, .workflow-step, .why-visual, .why-copy, .application-card, .studio-intro, .studio-card, .insight-card, .faq-intro, .faq-list, .contact-panel');
  const revealObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });
  revealItems.forEach((item, index) => {
    item.classList.add('reveal');
    item.style.transitionDelay = `${(index % 4) * 55}ms`;
    revealObserver.observe(item);
  });
}

const insightGrid = document.querySelector('#insight-grid');
const insightViewAll = document.querySelector('#insight-view-all');
const insightDialog = document.querySelector('#insight-dialog');
const insightArticles = new Map();
const insightImages = [
  { src: 'https://images.unsplash.com/photo-1631882456892-54a30e92fe4f?auto=format&fit=crop&w=800&q=80', alt: 'Humanoid robotics in a bright research space' },
  { src: 'https://www.nom.nl/content/uploads/2024/01/smart-factory-technologies-2000x1336.jpg', alt: 'Robotic arms working in an industrial environment' },
  { src: 'https://images.unsplash.com/photo-1786165015358-823e20237438?auto=format&fit=crop&w=800&q=80', alt: 'A humanoid robot displayed in a modern setting' },
];

function insightDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return { dateTime: date.toISOString(), label: new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date) };
}

function renderArticleBody(container, body) {
  const fragment = document.createDocumentFragment();
  let paragraphLines = [];
  let list = null;
  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const paragraph = document.createElement('p');
    paragraph.textContent = paragraphLines.join(' ');
    fragment.append(paragraph);
    paragraphLines = [];
  };
  const closeList = () => {
    if (!list) return;
    fragment.append(list);
    list = null;
  };

  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (!line.trim()) {
      flushParagraph();
      closeList();
    } else if (heading) {
      flushParagraph();
      closeList();
      const element = document.createElement(line.startsWith('###') ? 'h4' : 'h3');
      element.textContent = heading[1];
      fragment.append(element);
    } else if (bullet) {
      flushParagraph();
      if (!list) list = document.createElement('ul');
      const item = document.createElement('li');
      item.textContent = bullet[1];
      list.append(item);
    } else {
      closeList();
      paragraphLines.push(line.trim());
    }
  }
  flushParagraph();
  closeList();
  container.replaceChildren(fragment);
}

function renderInsights(articles) {
  insightGrid.replaceChildren();
  if (!articles.length) {
    const message = document.createElement('p');
    message.className = 'insight-message';
    message.textContent = 'No articles have been published yet. Published articles will appear here when they are ready.';
    insightGrid.append(message);
    return;
  }

  articles.forEach((article, index) => {
    const id = typeof article.id === 'string' ? article.id : article.slug;
    if (!id || typeof article.title !== 'string') return;
    insightArticles.set(id, article);
    const image = insightImages[index % insightImages.length];
    const keywords = Array.isArray(article.suggested_keywords) ? article.suggested_keywords : [];
    const category = typeof keywords[0] === 'string' && keywords[0].trim() ? keywords[0].trim() : 'AI & Robotics';
    const card = document.createElement('article');
    card.className = 'insight-card';

    const imageLink = document.createElement('a');
    imageLink.className = 'insight-image';
    imageLink.href = '#insights';
    imageLink.dataset.insightRead = id;
    imageLink.setAttribute('aria-label', `Read ${article.title}`);
    const imageElement = document.createElement('img');
    imageElement.src = image.src;
    imageElement.alt = image.alt;
    imageElement.loading = 'lazy';
    const categoryBadge = document.createElement('span');
    categoryBadge.textContent = category;
    imageLink.append(imageElement, categoryBadge);

    const copy = document.createElement('div');
    copy.className = 'insight-copy';
    const categoryLabel = document.createElement('small');
    categoryLabel.textContent = category;
    const title = document.createElement('h3');
    title.textContent = article.title;
    copy.append(categoryLabel, title);
    const published = insightDate(article.published_at);
    if (published) {
      const time = document.createElement('time');
      time.className = 'insight-date';
      time.dateTime = published.dateTime;
      time.textContent = published.label;
      copy.append(time);
    }
    const excerpt = document.createElement('p');
    excerpt.textContent = typeof article.excerpt === 'string' ? article.excerpt : '';
    copy.append(excerpt);
    const readMore = document.createElement('a');
    readMore.href = '#insights';
    readMore.dataset.insightRead = id;
    readMore.setAttribute('aria-label', `Read more: ${article.title}`);
    readMore.append(document.createTextNode('Read More '));
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    readMore.append(arrow);
    copy.append(readMore);
    card.append(imageLink, copy);
    insightGrid.append(card);
  });
}

async function loadPublishedInsights(limit = 3) {
  const response = await fetch(`/api/blog/public/articles?limit=${limit}`, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.articles)) {
    throw new Error('Published articles are temporarily unavailable. Please try again later.');
  }
  return data.articles;
}

insightGrid.addEventListener('click', (event) => {
  const link = event.target.closest('[data-insight-read]');
  if (!link) return;
  event.preventDefault();
  const article = insightArticles.get(link.dataset.insightRead);
  if (!article) return;
  document.querySelector('#insight-reader-title').textContent = article.title;
  document.querySelector('#insight-reader-category').textContent = Array.isArray(article.suggested_keywords) && article.suggested_keywords[0]
    ? article.suggested_keywords[0]
    : 'AI & Robotics';
  const dateElement = document.querySelector('#insight-reader-date');
  const published = insightDate(article.published_at);
  dateElement.hidden = !published;
  if (published) {
    dateElement.dateTime = published.dateTime;
    dateElement.textContent = published.label;
  }
  renderArticleBody(insightDialog.querySelector('.insight-reader-body'), typeof article.body === 'string' ? article.body : '');
  insightDialog.showModal();
});

insightDialog.querySelector('.insight-dialog-close').addEventListener('click', () => insightDialog.close());
insightDialog.addEventListener('click', (event) => {
  if (event.target === insightDialog) insightDialog.close();
});

insightViewAll.addEventListener('click', async () => {
  insightViewAll.disabled = true;
  insightViewAll.setAttribute('aria-busy', 'true');
  const label = insightViewAll.querySelector('span');
  insightViewAll.firstChild.textContent = 'Loading articles… ';
  try {
    const articles = await loadPublishedInsights(100);
    renderInsights(articles);
    insightGrid.setAttribute('aria-busy', 'false');
    insightGrid.dataset.state = 'loaded';
  } catch {
    const message = document.createElement('p');
    message.className = 'insight-message';
    message.textContent = 'Published articles are temporarily unavailable. Please try again later.';
    insightGrid.replaceChildren(message);
  } finally {
    insightViewAll.disabled = false;
    insightViewAll.removeAttribute('aria-busy');
    insightViewAll.firstChild.textContent = 'View All Articles ';
    if (label) label.textContent = '↗';
  }
});

loadPublishedInsights(3).then((articles) => {
  renderInsights(articles);
  insightGrid.setAttribute('aria-busy', 'false');
  insightViewAll.hidden = false;
}).catch(() => {
  const message = document.createElement('p');
  message.className = 'insight-message';
  message.textContent = 'Published articles are temporarily unavailable. Please try again later.';
  insightGrid.replaceChildren(message);
  insightGrid.setAttribute('aria-busy', 'false');
});
