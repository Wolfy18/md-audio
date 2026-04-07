use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UtteranceKind {
    Heading,
    Paragraph,
    Item,
    BlockQuote,
    TableRow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Utterance {
    pub text: String,
    pub start_offset: usize,
    pub end_offset: usize,
    pub kind: UtteranceKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkdownSection {
    pub heading: Option<Utterance>,
    pub utterances: Vec<Utterance>,
}

impl MarkdownSection {
    pub fn start_offset(&self) -> usize {
        self.heading
            .as_ref()
            .map(|heading| heading.start_offset)
            .or_else(|| self.utterances.first().map(|utterance| utterance.start_offset))
            .unwrap_or(0)
    }

    pub fn end_offset(&self) -> usize {
        self.utterances
            .last()
            .map(|utterance| utterance.end_offset)
            .or_else(|| self.heading.as_ref().map(|heading| heading.end_offset))
            .unwrap_or(self.start_offset())
    }

    pub fn heading_text(&self) -> Option<&str> {
        self.heading.as_ref().map(|heading| heading.text.trim())
    }

    pub fn body_text(&self) -> String {
        self.utterances
            .iter()
            .map(|utterance| utterance.text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn is_empty(&self) -> bool {
        self.heading.is_none() && self.utterances.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedMarkdownDocument {
    pub title: Option<Utterance>,
    pub utterances: Vec<Utterance>,
    pub sections: Vec<MarkdownSection>,
}

impl ParsedMarkdownDocument {
    pub fn from_utterances(utterances: Vec<Utterance>) -> Self {
        let title = utterances
            .iter()
            .find(|utterance| utterance.kind == UtteranceKind::Heading)
            .cloned();
        let sections = build_sections(&utterances);

        Self {
            title,
            utterances,
            sections,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Context {
    Heading {
        text: String,
        range: Option<Range<usize>>,
    },
    Paragraph {
        text: String,
        range: Option<Range<usize>>,
    },
    Item {
        text: String,
        range: Option<Range<usize>>,
        checked: Option<bool>,
    },
    BlockQuote {
        text: String,
        range: Option<Range<usize>>,
    },
    TableRow {
        cells: Vec<String>,
        range: Option<Range<usize>>,
        is_header: bool,
    },
    TableCell {
        text: String,
        range: Option<Range<usize>>,
    },
}

impl Context {
    fn append_text(&mut self, value: &str, range: &Range<usize>) {
        match self {
            Context::Heading { text, range: target, .. }
            | Context::Paragraph { text, range: target }
            | Context::Item { text, range: target, .. }
            | Context::BlockQuote { text, range: target }
            | Context::TableCell { text, range: target } => {
                push_spaced(text, value);
                merge_range(target, range);
            }
            Context::TableRow { .. } => {}
        }
    }

    fn absorb_segment(&mut self, value: &str, range: Range<usize>) {
        self.append_text(value, &range);
    }
}

pub fn parse_markdown_document(text: &str) -> ParsedMarkdownDocument {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_YAML_STYLE_METADATA_BLOCKS);
    options.insert(Options::ENABLE_PLUSES_DELIMITED_METADATA_BLOCKS);

    let parser = Parser::new_ext(text, options).into_offset_iter();

    let mut utterances = Vec::new();
    let mut stack: Vec<Context> = Vec::new();
    let mut ignored_depth = 0usize;

    for (event, range) in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { .. } => stack.push(Context::Heading {
                    text: String::new(),
                    range: None,
                }),
                Tag::Paragraph => stack.push(Context::Paragraph {
                    text: String::new(),
                    range: None,
                }),
                Tag::Item => stack.push(Context::Item {
                    text: String::new(),
                    range: None,
                    checked: None,
                }),
                Tag::BlockQuote(_) => stack.push(Context::BlockQuote {
                    text: String::new(),
                    range: None,
                }),
                Tag::TableHead => stack.push(Context::TableRow {
                    cells: Vec::new(),
                    range: Some(range.clone()),
                    is_header: true,
                }),
                Tag::TableRow => stack.push(Context::TableRow {
                    cells: Vec::new(),
                    range: Some(range.clone()),
                    is_header: false,
                }),
                Tag::TableCell => stack.push(Context::TableCell {
                    text: String::new(),
                    range: None,
                }),
                Tag::CodeBlock(_) | Tag::MetadataBlock(_) | Tag::Image { .. } => {
                    ignored_depth = ignored_depth.saturating_add(1);
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    if let Some(Context::Heading { text, range }) = stack.pop() {
                        finalize_text(&mut utterances, text, range, UtteranceKind::Heading);
                    }
                }
                TagEnd::Paragraph => {
                    if let Some(Context::Paragraph { text, range }) = stack.pop() {
                        if let Some(parent) = nearest_parent_context(&mut stack) {
                            if let Some(segment_range) = range.clone() {
                                parent.absorb_segment(&text, segment_range);
                            }
                        } else {
                            finalize_text(&mut utterances, text, range, UtteranceKind::Paragraph);
                        }
                    }
                }
                TagEnd::Item => {
                    if let Some(Context::Item {
                        text,
                        range,
                        checked,
                    }) = stack.pop()
                    {
                        let rendered = match checked {
                            Some(true) => format!("Done: {text}"),
                            Some(false) => format!("To do: {text}"),
                            None => text,
                        };
                        finalize_text(&mut utterances, rendered, range, UtteranceKind::Item);
                    }
                }
                TagEnd::BlockQuote(_) => {
                    if let Some(Context::BlockQuote { text, range }) = stack.pop() {
                        finalize_text(&mut utterances, text, range, UtteranceKind::BlockQuote);
                    }
                }
                TagEnd::TableHead => {
                    if let Some(Context::TableRow {
                        cells,
                        range,
                        is_header,
                    }) = stack.pop()
                    {
                        let text = render_table_row(&cells, is_header);
                        finalize_text(&mut utterances, text, range, UtteranceKind::TableRow);
                    }
                }
                TagEnd::TableCell => {
                    if let Some(Context::TableCell { text, range }) = stack.pop() {
                        if let Some(Context::TableRow {
                            cells,
                            range: row_range,
                            ..
                        }) = stack.last_mut()
                        {
                            let normalized = normalize_whitespace(&text);
                            if !normalized.is_empty() {
                                cells.push(normalized);
                            }
                            if let Some(segment_range) = range {
                                merge_range(row_range, &segment_range);
                            }
                        }
                    }
                }
                TagEnd::TableRow => {
                    if let Some(Context::TableRow {
                        cells,
                        range,
                        is_header,
                    }) = stack.pop()
                    {
                        let text = render_table_row(&cells, is_header);
                        finalize_text(&mut utterances, text, range, UtteranceKind::TableRow);
                    }
                }
                TagEnd::CodeBlock | TagEnd::MetadataBlock(_) | TagEnd::Image => {
                    ignored_depth = ignored_depth.saturating_sub(1);
                }
                _ => {}
            },
            Event::Text(value) if ignored_depth == 0 => {
                append_to_nearest_context(&mut stack, value.as_ref(), &range);
            }
            Event::Code(value) if ignored_depth == 0 => {
                append_to_nearest_context(&mut stack, render_inline_code(value.as_ref()).as_str(), &range);
            }
            Event::Html(_) | Event::InlineHtml(_) => {}
            Event::SoftBreak | Event::HardBreak if ignored_depth == 0 => {
                append_to_nearest_context(&mut stack, " ", &range);
            }
            Event::TaskListMarker(checked) if ignored_depth == 0 => {
                if let Some(Context::Item { checked: marker, .. }) =
                    stack.iter_mut().rev().find(|context| matches!(context, Context::Item { .. }))
                {
                    *marker = Some(checked);
                }
            }
            Event::FootnoteReference(reference) if ignored_depth == 0 => {
                append_to_nearest_context(&mut stack, reference.as_ref(), &range);
            }
            _ => {}
        }
    }

    ParsedMarkdownDocument::from_utterances(utterances)
}

pub fn parse_markdown(text: &str) -> Vec<Utterance> {
    parse_markdown_document(text).utterances
}

fn append_to_nearest_context(stack: &mut [Context], value: &str, range: &Range<usize>) {
    if let Some(context) = stack.iter_mut().rev().find(|context| {
        matches!(
            context,
            Context::Heading { .. }
                | Context::Paragraph { .. }
                | Context::Item { .. }
                | Context::BlockQuote { .. }
                | Context::TableCell { .. }
        )
    }) {
        context.append_text(value, range);
    }
}

fn nearest_parent_context(stack: &mut [Context]) -> Option<&mut Context> {
    stack
        .iter_mut()
        .rev()
        .find(|context| matches!(context, Context::Item { .. } | Context::BlockQuote { .. }))
}

fn finalize_text(
    utterances: &mut Vec<Utterance>,
    raw_text: String,
    range: Option<Range<usize>>,
    kind: UtteranceKind,
) {
    let Some(range) = range else {
        return;
    };

    let normalized = normalize_whitespace(&raw_text);

    if normalized.is_empty() {
        return;
    }

    for chunk in chunk_text(&normalized) {
        utterances.push(Utterance {
            text: chunk,
            start_offset: range.start,
            end_offset: range.end.max(range.start),
            kind,
        });
    }
}

fn normalize_whitespace(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn push_spaced(target: &mut String, value: &str) {
    let cleaned = value.replace('\n', " ");
    let trimmed = cleaned.trim();

    if trimmed.is_empty() {
        return;
    }

    if !target.is_empty()
        && !target.ends_with(' ')
        && !starts_with_inline_punctuation(trimmed)
    {
        target.push(' ');
    }

    target.push_str(trimmed);
}

fn starts_with_inline_punctuation(value: &str) -> bool {
    value
        .chars()
        .next()
        .is_some_and(|character| matches!(character, '.' | ',' | ':' | ';' | '!' | '?'))
}

fn merge_range(target: &mut Option<Range<usize>>, incoming: &Range<usize>) {
    match target {
        Some(existing) => {
            existing.start = existing.start.min(incoming.start);
            existing.end = existing.end.max(incoming.end);
        }
        None => {
            *target = Some(incoming.clone());
        }
    }
}

fn render_inline_code(value: &str) -> String {
    value
        .replace('_', " ")
        .replace("::", " ")
        .replace('/', " ")
        .replace('\\', " ")
}

fn render_table_row(cells: &[String], is_header: bool) -> String {
    let separator = if is_header { ", " } else { "; " };
    cells.join(separator)
}

fn build_sections(utterances: &[Utterance]) -> Vec<MarkdownSection> {
    let mut sections = Vec::new();
    let mut current = MarkdownSection {
        heading: None,
        utterances: Vec::new(),
    };

    for utterance in utterances {
        if utterance.kind == UtteranceKind::Heading {
            if !current.is_empty() {
                sections.push(current);
            }

            current = MarkdownSection {
                heading: Some(utterance.clone()),
                utterances: Vec::new(),
            };
            continue;
        }

        current.utterances.push(utterance.clone());
    }

    if !current.is_empty() {
        sections.push(current);
    }

    sections
}

fn chunk_text(input: &str) -> Vec<String> {
    if input.len() <= 180 {
        return vec![input.to_string()];
    }

    let mut sentences = Vec::new();
    let mut current = String::new();

    for character in input.chars() {
        current.push(character);

        if matches!(character, '.' | '!' | '?' | ';' | ':') && current.trim().len() >= 40 {
            sentences.push(current.trim().to_string());
            current.clear();
        }
    }

    if !current.trim().is_empty() {
        sentences.push(current.trim().to_string());
    }

    if sentences.len() <= 1 {
        return input
            .split(',')
            .map(str::trim)
            .filter(|segment| !segment.is_empty())
            .map(ToString::to_string)
            .collect();
    }

    sentences
}

#[cfg(test)]
mod tests {
    use super::{parse_markdown, parse_markdown_document};

    #[test]
    fn removes_front_matter_and_reads_headings() {
        let source = "---\ntitle: Demo\n---\n# Hello\n\nWorld";
        let utterances = parse_markdown(source);

        assert_eq!(utterances[0].text, "Hello");
        assert_eq!(utterances[1].text, "World");
        assert!(utterances[0].start_offset >= source.find("Hello").unwrap());
    }

    #[test]
    fn keeps_inline_code_and_skips_block_code() {
        let source = "Paragraph with `code` text.\n\n```rs\nlet hidden = true;\n```\n\nAfter";
        let utterances = parse_markdown(source);

        assert_eq!(utterances.len(), 2);
        assert_eq!(utterances[0].text, "Paragraph with code text.");
        assert_eq!(utterances[1].text, "After");
    }

    #[test]
    fn keeps_link_text_and_task_markers() {
        let source = "- [x] ship the [docs](https://example.com)\n- [ ] follow up";
        let utterances = parse_markdown(source);

        assert_eq!(utterances[0].text, "Done: ship the docs");
        assert_eq!(utterances[1].text, "To do: follow up");
    }

    #[test]
    fn reads_block_quotes_and_tables() {
        let source = "> quoted text\n\n| Name | Score |\n| --- | --- |\n| Ada | 10 |";
        let utterances = parse_markdown(source);

        assert_eq!(utterances[0].text, "quoted text");
        assert_eq!(utterances[1].text, "Name, Score");
        assert_eq!(utterances[2].text, "Ada; 10");
    }

    #[test]
    fn renders_inline_identifiers_more_naturally() {
        let source = "Use `OPENAI_API_KEY` with `src/lib.rs`.";
        let utterances = parse_markdown(source);

        assert_eq!(utterances[0].text, "Use OPENAI API KEY with src lib.rs.");
    }

    #[test]
    fn chunks_long_paragraphs() {
        let source = "Sentence one is deliberately a little bit longer than usual so the parser has a reason to split. Sentence two follows and should produce another utterance. Sentence three stays here too.";
        let utterances = parse_markdown(source);

        assert!(utterances.len() >= 2);
        assert_eq!(utterances[0].start_offset, 0);
        assert_eq!(utterances[0].end_offset, source.len());
    }

    #[test]
    fn groups_utterances_into_sections() {
        let source = "# Title\n\nIntro text.\n\n## Setup\n\nStep one.\n\n## Notes\n\nImportant caveat.";
        let document = parse_markdown_document(source);

        assert_eq!(document.title.as_ref().map(|title| title.text.as_str()), Some("Title"));
        assert_eq!(document.sections.len(), 3);
        assert_eq!(document.sections[0].heading_text(), Some("Title"));
        assert_eq!(document.sections[0].body_text(), "Intro text.");
        assert_eq!(document.sections[1].heading_text(), Some("Setup"));
        assert_eq!(document.sections[1].body_text(), "Step one.");
        assert_eq!(document.sections[2].heading_text(), Some("Notes"));
        assert_eq!(document.sections[2].body_text(), "Important caveat.");
    }
}
