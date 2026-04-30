// Chatbot behavior separated from index.html
const chatbotBtn = qs('#chatbotBtn');
const chatModal = qs('#chatModal');
const closeChatBtn = qs('#closeChatBtn');
const chatMessages = qs('#chatMessages');
const chatInput = qs('#chatInput');
const sendChatBtn = qs('#sendChatBtn');
const chatSubject = qs('#chatSubject');
const quizBtn = qs('#quizBtn');

let activeChat = null;
let chatRequestId = 0;

function updateChatbotVisibility() {
    if (chatbotBtn) {
        chatbotBtn.style.display = state.currentUser ? 'flex' : 'none';
    }
}

function getSubjectLabel(subject) {
    const labels = {
        biology: '생명과학',
        physics: '물리학',
        chemistry: '화학',
        earth: '지구과학',
        geography: '지리학',
    };
    return labels[subject] || '일반';
}

function setGenerating(isGenerating) {
    if (!sendChatBtn) return;
    const hasDraft = Boolean(chatInput?.value.trim());
    sendChatBtn.textContent = isGenerating
        ? hasDraft
            ? '새 질문'
            : '중지'
        : '전송';
    sendChatBtn.classList.toggle('is-stopping', isGenerating);
    sendChatBtn.setAttribute(
        'aria-label',
        isGenerating
            ? hasDraft
                ? '이전 답변을 중지하고 새 질문 전송'
                : '답변 생성 중지'
            : '질문 전송'
    );
}

function cancelActiveChat({ showNotice = false } = {}) {
    if (!activeChat) return;

    const { controller, loadingDiv } = activeChat;
    controller.abort();
    loadingDiv?.remove();
    activeChat = null;
    setGenerating(false);

    if (showNotice) {
        addChatMessage('assistant', '답변 생성을 중단했어요.');
    }
}

function addChatMessage(role, content) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = content;
    msgDiv.appendChild(bubble);

    if (role === 'assistant' && content) {
        const saveBtn = document.createElement('button');
        saveBtn.className = 'save-note-btn';
        saveBtn.textContent = '노트 저장';
        saveBtn.onclick = async () => {
            const title = prompt(
                '노트 제목을 입력하세요',
                `${getSubjectLabel(chatSubject.value)} 학습 내용`
            );
            if (!title) return;
            try {
                await api('/api/notes', 'POST', {
                    title,
                    content,
                    subject: chatSubject.value,
                });
                showToast('노트에 저장되었습니다!');
            } catch (err) {
                alert(err.data?.error || '저장 실패');
            }
        };
        msgDiv.appendChild(saveBtn);
    }

    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function postChat(payload, signal) {
    const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
        signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw Object.assign(new Error(data.error || '답변 생성 실패'), {
            status: res.status,
            data,
        });
    }
    return data;
}

async function sendChatMessage(withQuiz = false) {
    const message = chatInput.value.trim();
    if (!message) return;

    if (activeChat) {
        cancelActiveChat();
    }

    const requestId = ++chatRequestId;
    const subject = chatSubject.value;
    const controller = new AbortController();

    addChatMessage('user', message);
    chatInput.value = '';

    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'chat-message assistant is-loading';
    loadingDiv.innerHTML = '<div class="bubble">답변 생성 중...</div>';
    chatMessages.appendChild(loadingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    activeChat = { controller, loadingDiv, requestId };
    setGenerating(true);
    chatInput.focus();

    try {
        const res = await postChat(
            {
                message,
                subject,
                withQuiz,
            },
            controller.signal
        );

        if (!activeChat || activeChat.requestId !== requestId) return;

        loadingDiv.remove();
        addChatMessage('assistant', res.answer || '답변을 생성하지 못했어요.');
    } catch (err) {
        if (err.name === 'AbortError') return;
        if (!activeChat || activeChat.requestId !== requestId) return;

        loadingDiv.remove();
        addChatMessage(
            'assistant',
            '오류: ' + (err.data?.error || err.message || '답변 생성 실패')
        );
    } finally {
        if (activeChat?.requestId === requestId) {
            activeChat = null;
            setGenerating(false);
            chatInput.focus();
        }
    }
}

if (chatbotBtn) {
    chatbotBtn.addEventListener('click', () => {
        chatModal.classList.add('open');
        chatInput?.focus();
    });
}

if (closeChatBtn) {
    closeChatBtn.addEventListener('click', () => {
        chatModal.classList.remove('open');
    });
}

if (sendChatBtn) {
    sendChatBtn.addEventListener('click', () => {
        if (activeChat) {
            if (chatInput.value.trim()) {
                sendChatMessage(false);
                return;
            }
            cancelActiveChat({ showNotice: true });
            chatInput.focus();
            return;
        }
        sendChatMessage(false);
    });
}

if (chatInput) {
    chatInput.addEventListener('input', () => {
        if (activeChat) setGenerating(true);
    });

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage(false);
        }
    });
}

if (quizBtn) {
    quizBtn.addEventListener('click', () => {
        chatInput.value = '이 주제에 대한 퀴즈 3문제를 내주세요.';
        sendChatMessage(true);
    });
}

updateChatbotVisibility();
