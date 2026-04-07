use std::collections::HashSet;

use crate::markdown::{MarkdownSection, ParsedMarkdownDocument, Utterance, UtteranceKind};

const GENERIC_HEADINGS: &[&str] = &[
    "about",
    "appendix",
    "commands",
    "configuration",
    "contents",
    "current scope",
    "details",
    "development",
    "guide",
    "how it works",
    "index",
    "introduction",
    "notes",
    "overview",
    "readme",
    "reference",
    "summary",
    "usage",
];

const TASK_KEYWORDS: &[&str] = &[
    "action item",
    "action items",
    "backlog",
    "checklist",
    "milestone",
    "next step",
    "next steps",
    "plan",
    "roadmap",
    "task",
    "tasks",
    "todo",
    "to do",
];

const STATUS_KEYWORDS: &[&str] = &[
    "changelog",
    "completed",
    "progress",
    "release note",
    "release notes",
    "released",
    "shipped",
    "status",
    "update",
];

const CAVEAT_KEYWORDS: &[&str] = &[
    "boundary",
    "boundaries",
    "caveat",
    "caveats",
    "compatibility",
    "constraint",
    "constraints",
    "depends",
    "fallback",
    "limitation",
    "limitations",
    "note",
    "notes",
    "only",
    "requires",
    "unsupported",
    "warning",
];

const SETUP_KEYWORDS: &[&str] = &[
    "bootstrap",
    "build",
    "configure",
    "configuration",
    "development",
    "getting started",
    "install",
    "installation",
    "local",
    "package",
    "packaging",
    "quickstart",
    "run",
    "setup",
    "usage",
];

const REFERENCE_KEYWORDS: &[&str] = &[
    "api",
    "command",
    "commands",
    "config",
    "configuration",
    "env",
    "environment",
    "field",
    "flag",
    "interface",
    "option",
    "options",
    "parameter",
    "reference",
    "schema",
    "setting",
    "settings",
];

const RUNBOOK_KEYWORDS: &[&str] = &[
    "debug",
    "diagnose",
    "error",
    "incident",
    "mitigation",
    "recovery",
    "runbook",
    "troubleshoot",
    "troubleshooting",
];

const OVERVIEW_KEYWORDS: &[&str] = &[
    "architecture",
    "design",
    "how it works",
    "intro",
    "introduction",
    "overview",
    "scope",
    "system",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DocumentKind {
    OverviewDesign,
    SetupHowTo,
    ReferenceApi,
    RunbookTroubleshooting,
    StatusChangelog,
    TaskPlan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SectionRole {
    Overview,
    Setup,
    Reference,
    Runbook,
    Status,
    Task,
    Caveat,
    General,
}

#[derive(Clone, Debug)]
struct SectionProfile {
    index: usize,
    heading: Option<String>,
    lead_sentence: Option<String>,
    role: SectionRole,
    heading_is_generic: bool,
    topic: String,
    item_texts: Vec<String>,
    done_items: Vec<String>,
    todo_items: Vec<String>,
    overview_score: f32,
    technical_score: f32,
    action_score: f32,
    start_offset: usize,
    end_offset: usize,
}

pub fn summarize_document(document: &ParsedMarkdownDocument) -> Vec<Utterance> {
    if document.utterances.is_empty() {
        return Vec::new();
    }

    let profiles = build_section_profiles(document);
    if profiles.is_empty() {
        return fallback_summary(document);
    }

    let document_kind = classify_document(document, &profiles);
    let subject = detect_subject(document, &profiles);
    let target_count = summary_target_count(document, &profiles);

    let overview_index = select_overview_profile(&profiles);
    let primary_index = select_primary_profile(&profiles, overview_index);
    let action_index = select_action_profile(&profiles, overview_index, primary_index);

    let mut used = HashSet::new();
    let mut summary = Vec::new();

    if let Some(profile_index) = overview_index {
        let paragraph = build_overview_paragraph(&profiles[profile_index], &profiles, document_kind, subject.as_deref());
        push_summary_utterance(&mut summary, &profiles[profile_index], paragraph);
        used.insert(profile_index);
    }

    if let Some(profile_index) = primary_index {
        if used.insert(profile_index) {
            let paragraph = build_section_paragraph(&profiles[profile_index]);
            push_summary_utterance(&mut summary, &profiles[profile_index], paragraph);
        }
    }

    if summary.len() < target_count {
        if let Some(profile_index) = action_index {
            if used.insert(profile_index) {
                let paragraph = build_section_paragraph(&profiles[profile_index]);
                push_summary_utterance(&mut summary, &profiles[profile_index], paragraph);
            }
        }
    }

    if summary.len() < target_count {
        for profile in fallback_profiles(&profiles, &used) {
            let paragraph = build_section_paragraph(profile);
            push_summary_utterance(&mut summary, profile, paragraph);
            used.insert(profile.index);

            if summary.len() >= target_count {
                break;
            }
        }
    }

    if summary.is_empty() {
        fallback_summary(document)
    } else {
        summary
    }
}

pub fn summarize_utterances(utterances: &[Utterance]) -> Vec<Utterance> {
    let document = ParsedMarkdownDocument::from_utterances(utterances.to_vec());
    summarize_document(&document)
}

fn build_section_profiles(document: &ParsedMarkdownDocument) -> Vec<SectionProfile> {
    document
        .sections
        .iter()
        .enumerate()
        .filter_map(|(index, section)| profile_section(index, section))
        .collect()
}

fn profile_section(index: usize, section: &MarkdownSection) -> Option<SectionProfile> {
    let heading = section.heading_text().map(ToString::to_string);
    let body_text = section.body_text();

    if heading.is_none() && body_text.is_empty() {
        return None;
    }

    let lower_heading = heading.as_deref().map(normalize_for_matching);
    let combined_text = format!(
        "{} {}",
        lower_heading.as_deref().unwrap_or_default(),
        normalize_for_matching(&body_text)
    );
    let role = classify_section_role(&combined_text);
    let lead_sentence = section
        .utterances
        .iter()
        .find_map(|utterance| first_sentence(&utterance.text));
    let item_texts = section
        .utterances
        .iter()
        .filter(|utterance| utterance.kind == UtteranceKind::Item)
        .map(|utterance| utterance.text.trim().to_string())
        .collect::<Vec<_>>();
    let done_items = item_texts
        .iter()
        .filter_map(|item| item.strip_prefix("Done:"))
        .map(|item| item.trim().to_string())
        .collect::<Vec<_>>();
    let todo_items = item_texts
        .iter()
        .filter_map(|item| item.strip_prefix("To do:"))
        .map(|item| item.trim().to_string())
        .collect::<Vec<_>>();
    let heading_is_generic = heading
        .as_deref()
        .is_some_and(|heading| is_generic_heading(heading));
    let topic = choose_section_topic(heading.as_deref(), lead_sentence.as_deref());
    let body_length = body_text.split_whitespace().count() as f32;
    let overview_score = section_overview_score(index, role, body_length, heading_is_generic);
    let technical_score = section_technical_score(index, role, body_length, heading_is_generic);
    let action_score =
        section_action_score(index, role, body_length, heading_is_generic, &done_items, &todo_items);

    Some(SectionProfile {
        index,
        heading,
        lead_sentence,
        role,
        heading_is_generic,
        topic,
        item_texts,
        done_items,
        todo_items,
        overview_score,
        technical_score,
        action_score,
        start_offset: section.start_offset(),
        end_offset: section.end_offset(),
    })
}

fn classify_document(document: &ParsedMarkdownDocument, profiles: &[SectionProfile]) -> DocumentKind {
    let mut overview_score = 0.5f32;
    let mut setup_score = 0.5f32;
    let mut reference_score = 0.5f32;
    let mut runbook_score = 0.5f32;
    let mut status_score = 0.5f32;
    let mut task_score = 0.5f32;

    if let Some(title) = &document.title {
        let title_text = normalize_for_matching(&title.text);
        if contains_any(&title_text, OVERVIEW_KEYWORDS) {
            overview_score += 1.0;
        }
        if contains_any(&title_text, SETUP_KEYWORDS) {
            setup_score += 1.2;
        }
        if contains_any(&title_text, REFERENCE_KEYWORDS) {
            reference_score += 1.2;
        }
        if contains_any(&title_text, RUNBOOK_KEYWORDS) {
            runbook_score += 1.2;
        }
        if contains_any(&title_text, STATUS_KEYWORDS) {
            status_score += 1.4;
        }
        if contains_any(&title_text, TASK_KEYWORDS) {
            task_score += 1.4;
        }
    }

    for profile in profiles {
        match profile.role {
            SectionRole::Overview => overview_score += 1.0,
            SectionRole::Setup => setup_score += 1.0,
            SectionRole::Reference => reference_score += 1.0,
            SectionRole::Runbook => runbook_score += 1.0,
            SectionRole::Status => status_score += 1.2,
            SectionRole::Task => task_score += 1.2,
            SectionRole::Caveat => {
                runbook_score += 0.4;
                setup_score += 0.3;
            }
            SectionRole::General => overview_score += 0.4,
        }

        if !profile.todo_items.is_empty() {
            task_score += 1.0;
        }
        if !profile.done_items.is_empty() {
            status_score += 0.6;
        }
    }

    let mut candidates = [
        (DocumentKind::OverviewDesign, overview_score),
        (DocumentKind::SetupHowTo, setup_score),
        (DocumentKind::ReferenceApi, reference_score),
        (DocumentKind::RunbookTroubleshooting, runbook_score),
        (DocumentKind::StatusChangelog, status_score),
        (DocumentKind::TaskPlan, task_score),
    ];

    candidates.sort_by(|left, right| right.1.partial_cmp(&left.1).unwrap());
    candidates[0].0
}

fn detect_subject(document: &ParsedMarkdownDocument, profiles: &[SectionProfile]) -> Option<String> {
    if let Some(title) = &document.title {
        let title = title.text.trim();
        if !title.is_empty() && !is_generic_heading(title) {
            return Some(title.to_string());
        }
    }

    for profile in profiles {
        if let Some(sentence) = profile.lead_sentence.as_deref() {
            if let Some(subject) = extract_subject_from_sentence(sentence) {
                return Some(subject);
            }
        }
    }

    None
}

fn select_overview_profile(profiles: &[SectionProfile]) -> Option<usize> {
    profiles
        .iter()
        .enumerate()
        .max_by(|left, right| {
            left.1
                .overview_score
                .partial_cmp(&right.1.overview_score)
                .unwrap()
                .then_with(|| right.1.index.cmp(&left.1.index))
        })
        .map(|(index, _)| index)
}

fn select_primary_profile(profiles: &[SectionProfile], overview_index: Option<usize>) -> Option<usize> {
    profiles
        .iter()
        .enumerate()
        .filter(|(index, _)| Some(*index) != overview_index)
        .filter(|(_, profile)| profile.role != SectionRole::Task && profile.role != SectionRole::Status)
        .max_by(|left, right| {
            left.1
                .technical_score
                .partial_cmp(&right.1.technical_score)
                .unwrap()
                .then_with(|| right.1.index.cmp(&left.1.index))
        })
        .map(|(index, _)| index)
}

fn select_action_profile(
    profiles: &[SectionProfile],
    overview_index: Option<usize>,
    primary_index: Option<usize>,
) -> Option<usize> {
    profiles
        .iter()
        .enumerate()
        .filter(|(index, _)| Some(*index) != overview_index && Some(*index) != primary_index)
        .filter(|(_, profile)| {
            matches!(
                profile.role,
                SectionRole::Task | SectionRole::Status | SectionRole::Caveat | SectionRole::Runbook
            )
        })
        .max_by(|left, right| {
            left.1
                .action_score
                .partial_cmp(&right.1.action_score)
                .unwrap()
                .then_with(|| right.1.index.cmp(&left.1.index))
        })
        .map(|(index, _)| index)
}

fn fallback_profiles<'a>(profiles: &'a [SectionProfile], used: &HashSet<usize>) -> Vec<&'a SectionProfile> {
    let mut remaining = profiles
        .iter()
        .filter(|profile| !used.contains(&profile.index))
        .collect::<Vec<_>>();

    remaining.sort_by(|left, right| {
        right
            .technical_score
            .partial_cmp(&left.technical_score)
            .unwrap()
            .then_with(|| left.index.cmp(&right.index))
    });

    remaining
}

fn summary_target_count(document: &ParsedMarkdownDocument, profiles: &[SectionProfile]) -> usize {
    if document.utterances.len() <= 2 || profiles.len() <= 1 {
        1
    } else if document.utterances.len() >= 8 || profiles.len() >= 4 {
        3
    } else {
        2
    }
}

fn build_overview_paragraph(
    overview: &SectionProfile,
    profiles: &[SectionProfile],
    document_kind: DocumentKind,
    subject: Option<&str>,
) -> String {
    let purpose_sentence = overview
        .lead_sentence
        .as_deref()
        .filter(|sentence| sentence.split_whitespace().count() >= 6)
        .map(normalize_sentence);
    let descriptor = document_descriptor(document_kind);
    let topics = collect_document_topics(profiles, subject);
    let mut sentences = Vec::new();

    let descriptor_mentions_subject = subject
        .zip(purpose_sentence.as_deref())
        .is_some_and(|(subject, sentence)| starts_with_phrase(sentence, subject));

    if let Some(subject) = subject {
        if descriptor_mentions_subject {
            sentences.push(format!("This file serves as {descriptor}."));
        } else {
            sentences.push(format!("This file serves as {descriptor} for {subject}."));
        }
    } else {
        sentences.push(format!("This file serves as {descriptor}."));
    }

    if let Some(sentence) = purpose_sentence {
        let mentions_topics = topics.iter().any(|topic| starts_with_phrase(&sentence, topic) || normalize_for_matching(&sentence).contains(&normalize_for_matching(topic)));
        sentences.push(sentence);
        if !topics.is_empty() && !mentions_topics {
            sentences.push(format!("It focuses on {}.", format_series(&topics)));
        }
    } else if !topics.is_empty() {
        sentences.push(format!("It covers {}.", format_series(&topics)));
    }

    normalize_sentence(&sentences.join(" "))
}

fn build_section_paragraph(profile: &SectionProfile) -> String {
    match profile.role {
        SectionRole::Task => summarize_task_section(profile),
        SectionRole::Status => summarize_status_section(profile),
        SectionRole::Caveat => summarize_caveat_section(profile),
        _ => summarize_general_section(profile),
    }
}

fn summarize_task_section(profile: &SectionProfile) -> String {
    let heading = section_reference(profile);
    let mut segments = Vec::new();

    if !profile.done_items.is_empty() {
        segments.push(format!(
            "completed work such as {}",
            format_series(&sample_items(&profile.done_items))
        ));
    }
    if !profile.todo_items.is_empty() {
        segments.push(format!(
            "remaining work such as {}",
            format_series(&sample_items(&profile.todo_items))
        ));
    }

    if !segments.is_empty() {
        return format!("{heading} tracks {}.", join_with_and(&segments));
    }

    summarize_general_section(profile)
}

fn summarize_status_section(profile: &SectionProfile) -> String {
    let heading = section_reference(profile);

    if !profile.item_texts.is_empty() {
        return format!(
            "{heading} summarizes items such as {}.",
            format_series(&sample_items(&profile.item_texts))
        );
    }

    if let Some(sentence) = profile.lead_sentence.as_deref() {
        return format!(
            "{heading} summarizes that {}.",
            sentence_to_clause(sentence)
        );
    }

    format!("{heading} summarizes {}.", profile.topic)
}

fn summarize_caveat_section(profile: &SectionProfile) -> String {
    let heading = section_reference(profile);

    if let Some(sentence) = profile.lead_sentence.as_deref() {
        return format!("{heading} calls out that {}.", sentence_to_clause(sentence));
    }

    format!("{heading} calls out {}.", profile.topic)
}

fn summarize_general_section(profile: &SectionProfile) -> String {
    let heading = section_reference(profile);

    if !profile.item_texts.is_empty() {
        let verb = match profile.role {
            SectionRole::Setup => "walks through steps such as",
            SectionRole::Reference => "lists items such as",
            SectionRole::Runbook => "walks through actions such as",
            SectionRole::Overview | SectionRole::General | SectionRole::Caveat | SectionRole::Status | SectionRole::Task => {
                "highlights points such as"
            }
        };
        return format!("{heading} {verb} {}.", format_series(&sample_items(&profile.item_texts)));
    }

    if let Some(sentence) = profile.lead_sentence.as_deref() {
        let verb = match profile.role {
            SectionRole::Setup => "explains",
            SectionRole::Reference => "documents",
            SectionRole::Runbook => "describes",
            SectionRole::Overview | SectionRole::General | SectionRole::Caveat | SectionRole::Status | SectionRole::Task => {
                "explains"
            }
        };

        return format!("{heading} {verb} that {}.", sentence_to_clause(sentence));
    }

    format!("{heading} covers {}.", profile.topic)
}

fn push_summary_utterance(summary: &mut Vec<Utterance>, profile: &SectionProfile, text: String) {
    let normalized = normalize_sentence(&text);
    if normalized.is_empty() {
        return;
    }

    summary.push(Utterance {
        text: normalized,
        start_offset: profile.start_offset,
        end_offset: profile.end_offset.max(profile.start_offset),
        kind: UtteranceKind::Paragraph,
    });
}

fn fallback_summary(document: &ParsedMarkdownDocument) -> Vec<Utterance> {
    let Some(first) = document.utterances.first() else {
        return Vec::new();
    };

    let subject = document
        .title
        .as_ref()
        .map(|title| title.text.trim())
        .filter(|title| !title.is_empty() && !is_generic_heading(title))
        .map(ToString::to_string);

    let sentence = if let Some(subject) = subject {
        format!(
            "This file serves as an engineering overview for {subject}. {}",
            normalize_sentence(&first.text)
        )
    } else {
        format!(
            "This file serves as an engineering overview. {}",
            normalize_sentence(&first.text)
        )
    };

    vec![Utterance {
        text: normalize_sentence(&sentence),
        start_offset: first.start_offset,
        end_offset: first.end_offset,
        kind: UtteranceKind::Paragraph,
    }]
}

fn classify_section_role(text: &str) -> SectionRole {
    if contains_any(text, TASK_KEYWORDS) || text.contains("to do:") || text.contains("done:") {
        SectionRole::Task
    } else if contains_any(text, STATUS_KEYWORDS) {
        SectionRole::Status
    } else if contains_any(text, CAVEAT_KEYWORDS) {
        SectionRole::Caveat
    } else if contains_any(text, SETUP_KEYWORDS) {
        SectionRole::Setup
    } else if contains_any(text, REFERENCE_KEYWORDS) {
        SectionRole::Reference
    } else if contains_any(text, RUNBOOK_KEYWORDS) {
        SectionRole::Runbook
    } else if contains_any(text, OVERVIEW_KEYWORDS) {
        SectionRole::Overview
    } else {
        SectionRole::General
    }
}

fn section_overview_score(index: usize, role: SectionRole, body_length: f32, heading_is_generic: bool) -> f32 {
    let mut score = if index == 0 { 3.0 } else { 0.8f32.max(2.0 - index as f32 * 0.3) };

    score += match role {
        SectionRole::Overview => 1.6,
        SectionRole::Setup => 1.0,
        SectionRole::Reference => 0.8,
        SectionRole::Runbook => 0.5,
        SectionRole::Status => 0.3,
        SectionRole::Task => 0.2,
        SectionRole::Caveat => 0.4,
        SectionRole::General => 0.7,
    };

    score += (body_length / 36.0).min(1.4);

    if heading_is_generic {
        score -= 0.3;
    }

    score
}

fn section_technical_score(index: usize, role: SectionRole, body_length: f32, heading_is_generic: bool) -> f32 {
    let mut score = 0.5f32.max(2.2 - index as f32 * 0.2);

    score += match role {
        SectionRole::Overview => 1.0,
        SectionRole::Setup => 1.5,
        SectionRole::Reference => 1.4,
        SectionRole::Runbook => 1.1,
        SectionRole::Status => 0.7,
        SectionRole::Task => 0.4,
        SectionRole::Caveat => 0.8,
        SectionRole::General => 0.9,
    };

    score += (body_length / 40.0).min(1.3);

    if heading_is_generic {
        score -= 0.2;
    } else {
        score += 0.4;
    }

    score
}

fn section_action_score(
    index: usize,
    role: SectionRole,
    body_length: f32,
    heading_is_generic: bool,
    done_items: &[String],
    todo_items: &[String],
) -> f32 {
    let mut score = index as f32 * 0.2;

    score += match role {
        SectionRole::Task => 3.2,
        SectionRole::Status => 2.8,
        SectionRole::Caveat => 2.6,
        SectionRole::Runbook => 2.2,
        SectionRole::Setup => 1.2,
        SectionRole::Reference => 0.4,
        SectionRole::Overview => 0.4,
        SectionRole::General => 0.5,
    };

    score += (body_length / 60.0).min(0.8);

    if !done_items.is_empty() {
        score += 0.8;
    }
    if !todo_items.is_empty() {
        score += 1.2;
    }
    if heading_is_generic {
        score += 0.2;
    }

    score
}

fn choose_section_topic(heading: Option<&str>, lead_sentence: Option<&str>) -> String {
    if let Some(heading) = heading {
        let heading = heading.trim();
        if !heading.is_empty() && !is_generic_heading(heading) {
            return heading.to_string();
        }
    }

    lead_sentence
        .map(topic_from_sentence)
        .filter(|topic| !topic.is_empty())
        .unwrap_or_else(|| "the core implementation details".to_string())
}

fn collect_document_topics(profiles: &[SectionProfile], subject: Option<&str>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut topics = Vec::new();

    for profile in profiles {
        if profile.heading_is_generic {
            continue;
        }

        let topic = lowercase_sentence_start(&profile.topic);
        if topic.is_empty() {
            continue;
        }
        if subject.is_some_and(|subject| starts_with_phrase(&topic, subject)) {
            continue;
        }
        if seen.insert(topic.clone()) {
            topics.push(topic);
        }
        if topics.len() >= 4 {
            break;
        }
    }

    topics
}

fn extract_subject_from_sentence(sentence: &str) -> Option<String> {
    let trimmed = sentence.trim();
    let lowered = normalize_for_matching(trimmed);
    let verbs = [
        " is ",
        " are ",
        " provides ",
        " explains ",
        " describes ",
        " documents ",
        " supports ",
        " lets ",
        " helps ",
        " enables ",
        " covers ",
    ];

    for verb in verbs {
        let Some(index) = lowered.find(verb) else {
            continue;
        };

        let candidate = trimmed[..index]
            .trim_matches(|character: char| matches!(character, '.' | ',' | ':' | ';' | ' '));
        if is_meaningful_subject(candidate) {
            return Some(candidate.to_string());
        }
    }

    None
}

fn is_meaningful_subject(candidate: &str) -> bool {
    if candidate.is_empty() {
        return false;
    }

    let lowered = normalize_for_matching(candidate);
    if matches!(
        lowered.as_str(),
        "it" | "this" | "this document" | "this file" | "the file" | "the document" | "this markdown file"
    ) {
        return false;
    }

    let word_count = candidate.split_whitespace().count();
    (1..=8).contains(&word_count)
}

fn contains_any(text: &str, keywords: &[&str]) -> bool {
    let padded = format!(" {text} ");
    keywords
        .iter()
        .any(|keyword| padded.contains(format!(" {keyword} ").as_str()))
}

fn document_descriptor(kind: DocumentKind) -> &'static str {
    match kind {
        DocumentKind::OverviewDesign => "an engineering overview",
        DocumentKind::SetupHowTo => "a setup and usage guide",
        DocumentKind::ReferenceApi => "a technical reference",
        DocumentKind::RunbookTroubleshooting => "an operational runbook",
        DocumentKind::StatusChangelog => "a status and change log",
        DocumentKind::TaskPlan => "a planning and task-tracking document",
    }
}

fn section_reference(profile: &SectionProfile) -> String {
    if let Some(heading) = profile.heading.as_deref() {
        return format!("The {heading} section");
    }

    "This part of the file".to_string()
}

fn sample_items(items: &[String]) -> Vec<String> {
    let stripped = strip_shared_prefix(items);
    stripped
        .into_iter()
        .take(3)
        .map(|item| normalize_sentence(&item))
        .map(|item| item.trim_end_matches('.').to_string())
        .collect()
}

fn strip_shared_prefix(items: &[String]) -> Vec<String> {
    let shared_prefix = shared_item_prefix(items);

    items
        .iter()
        .map(|item| match shared_prefix.as_deref() {
            Some(prefix) => item.strip_prefix(prefix).unwrap_or(item.as_str()).trim().to_string(),
            None => item.trim().to_string(),
        })
        .collect()
}

fn shared_item_prefix(items: &[String]) -> Option<String> {
    let prefixes = items
        .iter()
        .take(3)
        .filter_map(|item| item.split_once(':').map(|(prefix, _)| prefix.trim().to_string()))
        .collect::<Vec<_>>();

    if prefixes.len() < 2 {
        return None;
    }

    let first = prefixes.first()?;
    if prefixes.iter().all(|prefix| prefix == first) && first.split_whitespace().count() <= 3 {
        Some(format!("{first}:"))
    } else {
        None
    }
}

fn first_sentence(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    let sentence = trimmed
        .split_inclusive(['.', '!', '?'])
        .find(|segment| segment.trim().split_whitespace().count() >= 4)
        .unwrap_or(trimmed);

    Some(normalize_sentence(sentence))
}

fn normalize_sentence(text: &str) -> String {
    let trimmed = text.trim().replace('\n', " ");
    if trimmed.is_empty() {
        return String::new();
    }

    let collapsed = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.ends_with(['.', '!', '?']) {
        collapsed
    } else {
        format!("{collapsed}.")
    }
}

fn sentence_to_clause(sentence: &str) -> String {
    lowercase_sentence_start(strip_terminal_punctuation(sentence))
}

fn strip_terminal_punctuation(sentence: &str) -> &str {
    sentence
        .trim()
        .trim_end_matches(|character: char| matches!(character, '.' | '!' | '?'))
}

fn normalize_for_matching(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_alphanumeric() || character.is_whitespace() {
                character.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_generic_heading(heading: &str) -> bool {
    GENERIC_HEADINGS.contains(&normalize_for_matching(heading).as_str())
}

fn starts_with_phrase(text: &str, phrase: &str) -> bool {
    normalize_for_matching(text).starts_with(&normalize_for_matching(phrase))
}

fn lowercase_sentence_start(value: &str) -> String {
    let trimmed = value.trim();
    let mut characters = trimmed.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    let Some(second) = characters.clone().next() else {
        return trimmed.to_string();
    };

    if first.is_uppercase() && second.is_lowercase() {
        let mut lowered = String::new();
        lowered.extend(first.to_lowercase());
        lowered.push_str(characters.as_str());
        lowered
    } else {
        trimmed.to_string()
    }
}

fn format_series(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [left, right] => format!("{left} and {right}"),
        _ => {
            let mut items = items.to_vec();
            let last = items.pop().unwrap();
            format!("{}, and {}", items.join(", "), last)
        }
    }
}

fn join_with_and(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [left, right] => format!("{left} and {right}"),
        _ => format_series(items),
    }
}

fn topic_from_sentence(sentence: &str) -> String {
    let clause = strip_terminal_punctuation(sentence);
    let words = clause.split_whitespace().take(10).collect::<Vec<_>>();
    if words.is_empty() {
        "the core implementation details".to_string()
    } else {
        words.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::summarize_document;
    use crate::markdown::parse_markdown_document;

    #[test]
    fn rewrites_short_documents_into_a_clear_overview() {
        let source =
            "# Cache Rules\n\nThe cache invalidation flow relies on versioned keys and a background sweeper.";
        let document = parse_markdown_document(source);
        let summary = summarize_document(&document);

        assert_eq!(summary.len(), 1);
        assert!(summary[0].text.contains("Cache Rules"));
        assert!(summary[0].text.contains("versioned keys"));
    }

    #[test]
    fn summarizes_design_docs_by_purpose_and_main_sections() {
        let source = "# Event Pipeline\n\nEvent Pipeline is the ingestion path for billing webhooks.\n\n## Architecture\n\nThe service accepts webhook traffic, normalizes payloads, and publishes internal events.\n\n## Processing\n\nWorkers validate events, persist them, and fan out updates to downstream consumers.\n\n## Notes\n\nRetries are bounded and dead-letter traffic is inspected manually.";
        let document = parse_markdown_document(source);
        let summary = summarize_document(&document);

        assert_eq!(summary.len(), 3);
        assert!(summary[0].text.contains("engineering overview"));
        assert!(summary[0].text.contains("Event Pipeline"));
        assert!(summary[1].text.contains("Architecture"));
        assert!(summary[1].text.contains("webhook traffic"));
        assert!(summary[2].text.to_lowercase().contains("retries are bounded"));
        assert!(summary[2].start_offset >= source.find("## Notes").unwrap());
    }

    #[test]
    fn turns_setup_docs_into_guided_summary_paragraphs() {
        let source = "# Local Setup\n\nThis guide explains how to run the worker locally.\n\n## Install\n\nInstall uv and create the virtual environment before running the worker.\n\n## Configure\n\nSet OPENAI_API_KEY and point the app at the staging database.\n\n## Notes\n\nThe local worker only supports Apple Silicon today.";
        let document = parse_markdown_document(source);
        let summary = summarize_document(&document);
        let joined = summary
            .iter()
            .map(|utterance| utterance.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        assert!(joined.contains("setup and usage guide"));
        assert!(joined.contains("Install"));
        assert!(joined.contains("Apple Silicon"));
    }

    #[test]
    fn rewrites_task_lists_into_completed_and_remaining_work() {
        let source = "# Release Plan\n\nThis file tracks release work for the billing migration.\n\n## Checklist\n\n- [x] backfill customer balances\n- [ ] verify webhook replay in staging\n- [ ] schedule production rollout";
        let document = parse_markdown_document(source);
        let summary = summarize_document(&document);
        let joined = summary
            .iter()
            .map(|utterance| utterance.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        assert!(joined.contains("completed work such as backfill customer balances"));
        assert!(joined.contains("remaining work such as verify webhook replay in staging"));
    }

    #[test]
    fn deprioritizes_generic_headings_when_describing_document_topics() {
        let source = "# README\n\nAcme Worker is the background processor for invoice exports.\n\n## Overview\n\nIt consumes jobs from Redis and streams progress back to the API.\n\n## Reconciliation Flow\n\nThe reconciliation flow groups payouts, emits audit events, and records settlement state.\n\n## Notes\n\nOnly production uses the settlement lock.";
        let document = parse_markdown_document(source);
        let summary = summarize_document(&document);

        assert!(summary[0].text.contains("Acme Worker"));
        assert!(summary[0].text.to_lowercase().contains("reconciliation flow"));
    }
}
