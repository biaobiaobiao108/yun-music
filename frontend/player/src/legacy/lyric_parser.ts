import { getNow, TimeoutTools } from './lyric_utils';

type LyricWord = { startTime: number; duration: number; text: string };
type LyricLine = { time: number; text: string; words: LyricWord[] | null; extendedLyrics: string[] };
type LinePlayerOptions = {
    offset?: number;
    rate?: number;
    onPlay?: (line: number, text: string, currentTime: number) => void;
    onSetLyric?: (lines: LyricLine[], offset: number) => void;
};

const tagNames: Record<string, string> = { title: 'ti', artist: 'ar', album: 'al', offset: 'offset', by: 'by' };
const timeFieldExp = /^(?:\[[\d:.]+\])+/;
const timeExp = /\d{1,3}(?::\d{1,3}){0,2}(?:\.\d{1,3})?/g;

function normalizeTimeLabel(label: string): string {
    return label.replace(/^0+(\d+)/, '$1').replace(/:0+(\d+)/g, ':$1').replace(/\.0+(\d+)/, '.$1');
}

function parseTime(label: string): number {
    const parts = normalizeTimeLabel(label).split(':');
    while (parts.length < 3) parts.unshift('0');
    const seconds = parts.pop() || '0';
    const [whole, fraction = '0'] = seconds.split('.');
    return Number(parts[0]) * 3600000 + Number(parts[1]) * 60000 + Number(whole) * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3));
}

function parseWords(text: string): LyricWord[] {
    const words: LyricWord[] = [];
    const anglePattern = /<(\d+),(\d+)(?:,\d+)?>((?:[^<]|<(?!\d+,))+)/g;
    for (const match of text.matchAll(anglePattern)) words.push({ startTime: Number(match[1]), duration: Number(match[2]), text: match[3] });
    if (words.length) return words;
    const parenthesisPattern = /\((\d+),(\d+)\)([^([]*)/g;
    for (const match of text.matchAll(parenthesisPattern)) words.push({ startTime: Number(match[1]), duration: Number(match[2]), text: match[3] });
    return words;
}

function parseLines(lyric: string, extendedLyrics: string[]): { lines: LyricLine[]; tags: Record<string, string | number> } {
    const tags: Record<string, string | number> = {};
    for (const [name, tag] of Object.entries(tagNames)) {
        tags[name] = lyric.match(new RegExp(`\\[${tag}:([^\\]]*)\\]`, 'i'))?.[1] || '';
    }
    tags.offset = Number.parseInt(String(tags.offset || '0'), 10) || 0;

    const linesMap: Record<string, LyricLine> = {};
    for (const rawLine of lyric.split(/\r\n|\r|\n/)) {
        const line = rawLine.trim();
        const timeField = line.match(timeFieldExp)?.[0];
        if (!timeField) continue;
        const text = line.slice(timeField.length).trim();
        if (!text) continue;
        const times = timeField.match(timeExp) || [];
        for (const time of times) {
            const key = normalizeTimeLabel(time);
            if (linesMap[key]) {
                linesMap[key].extendedLyrics.push(text);
                continue;
            }
            const words = parseWords(text);
            linesMap[key] = {
                time: parseTime(time),
                text: text.replace(/<[\d,]+>|\(\d+,\d+\)/g, '').trim(),
                words: words.length ? words : null,
                extendedLyrics: [],
            };
        }
    }

    for (const extendedLyric of extendedLyrics) {
        for (const rawLine of extendedLyric.split(/\r\n|\r|\n/)) {
            const line = rawLine.trim();
            const timeField = line.match(timeFieldExp)?.[0];
            const text = timeField ? line.slice(timeField.length).trim() : '';
            if (!timeField || !text || text === '//') continue;
            for (const time of timeField.match(timeExp) || []) {
                linesMap[normalizeTimeLabel(time)]?.extendedLyrics.push(text);
            }
        }
    }

    return {
        tags,
        lines: Object.values(linesMap).sort((a, b) => a.time - b.time),
    };
}

export class LinePlayer {
    private lyric = '';
    private extendedLyrics: string[] = [];
    private tags: Record<string, string | number> = {};
    private lines: LyricLine[] = [];
    private isPlay = false;
    private curLineNum = 0;
    private maxLine = 0;
    private performanceTime = 0;
    private startTime = 0;
    private rate: number;
    public offset: number;
    private readonly timeoutTools = new TimeoutTools();
    private readonly onPlay: NonNullable<LinePlayerOptions['onPlay']>;
    private readonly onSetLyric: NonNullable<LinePlayerOptions['onSetLyric']>;

    constructor(options: LinePlayerOptions = {}) {
        this.offset = options.offset || 0;
        this.rate = options.rate || 1;
        this.onPlay = options.onPlay || (() => undefined);
        this.onSetLyric = options.onSetLyric || (() => undefined);
    }

    setOffset(offset: number): void {
        this.offset = offset || 0;
        this.performanceTime = getNow() - Number(this.tags.offset || 0) - this.offset;
        if (this.lines.length && this.isPlay) {
            this.curLineNum = this.findCurrentLine(this.currentTime()) - 1;
            this.refresh();
        }
    }

    private currentTime(): number {
        return (getNow() - this.performanceTime) * this.rate + this.startTime;
    }

    private findCurrentLine(time: number, startIndex = 0): number {
        if (time <= 0 || !this.lines.length) return 0;
        for (let index = startIndex; index < this.lines.length; index++) {
            if (time < this.lines[index].time) return index === 0 ? 0 : index - 1;
        }
        return this.lines.length - 1;
    }

    private refresh(): void {
        if (!this.lines.length) return;
        this.curLineNum++;
        if (this.curLineNum >= this.maxLine) {
            const last = this.lines[this.maxLine];
            this.onPlay(this.maxLine, last.text, this.currentTime());
            this.pause();
            return;
        }
        const current = this.lines[this.curLineNum];
        const now = this.currentTime();
        const drift = now - current.time;
        if (drift >= 0) {
            const next = this.lines[this.curLineNum + 1];
            if (!next) return this.refresh();
            const delay = (next.time - current.time - drift) / this.rate;
            if (delay > 0 && this.isPlay) this.timeoutTools.start(() => this.isPlay && this.refresh(), delay);
            this.onPlay(this.curLineNum, current.text, now);
            if (delay <= 0) this.refresh();
            return;
        }
        if (this.curLineNum === 0) {
            const delay = (current.time - now) / this.rate;
            if (this.isPlay) this.timeoutTools.start(() => this.isPlay && this.refresh(), delay);
            this.onPlay(-1, '', now);
            return;
        }
        this.curLineNum = this.findCurrentLine(now, this.curLineNum) - 1;
        this.refresh();
    }

    private initialize(): void {
        const parsed = parseLines(this.lyric, this.extendedLyrics);
        this.tags = parsed.tags;
        this.lines = parsed.lines;
        this.maxLine = this.lines.length - 1;
        this.onSetLyric(this.lines, Number(this.tags.offset) + this.offset);
    }

    play(currentTime = 0): void {
        if (!this.lines.length) return;
        if (this.isPlay && Math.abs(this.currentTime() - currentTime) < 100) return;
        this.pause();
        this.isPlay = true;
        this.performanceTime = getNow() - Number(this.tags.offset || 0) - this.offset;
        this.startTime = currentTime;
        this.curLineNum = this.findCurrentLine(this.currentTime()) - 1;
        this.refresh();
    }

    pause(): void {
        if (!this.isPlay) return;
        this.isPlay = false;
        this.timeoutTools.clear();
        if (!this.lines.length || this.curLineNum === this.maxLine) return;
        const currentLine = this.findCurrentLine(this.currentTime());
        if (this.curLineNum !== currentLine) {
            this.curLineNum = currentLine;
            this.onPlay(currentLine, this.lines[currentLine].text, this.currentTime());
        }
    }

    setPlaybackRate(rate: number): void {
        this.rate = rate;
        if (this.lines.length && this.isPlay) this.play(this.currentTime());
    }

    setLyric(lyric: string, extendedLyrics: string[] = []): void {
        if (this.isPlay) this.pause();
        this.lyric = lyric || '';
        this.extendedLyrics = extendedLyrics || [];
        this.initialize();
    }
}

(window as any).LinePlayer = LinePlayer;
