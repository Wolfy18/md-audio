use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};

use crate::markdown::Utterance;

const ENGLISH_STOP_WORDS: &[&str] = &[
    "about", "after", "also", "because", "been", "before", "between", "could", "does",
    "each", "from", "have", "into", "more", "most", "other", "over", "such", "than",
    "that", "their", "them", "then", "there", "these", "they", "this", "those", "through",
    "very", "what", "when", "where", "which", "while", "with", "would", "your",
];

const SPANISH_STOP_WORDS: &[&str] = &[
    "algo", "ante", "bajo", "cada", "como", "cuando", "desde", "donde", "durante", "entre",
    "esta", "este", "estos", "hacia", "hasta", "incluso", "mientras", "mucho", "para",
    "pero", "porque", "quien", "sobre", "tambien", "tanto", "tiene", "todos", "tras", "una",
    "unas", "unos",
];

pub fn summarize_utterances(utterances: &[Utterance]) -> Vec<Utterance> {
    if utterances.len() <= 4 {
        return utterances.to_vec();
    }

    let target_count = summary_target_count(utterances.len());
    let token_scores = score_tokens(utterances);
    let mut ranked = utterances
        .iter()
        .enumerate()
        .map(|(index, utterance)| (score_utterance(index, utterance, utterances.len(), &token_scores), index))
        .filter(|(score, _)| *score > 0.0)
        .collect::<Vec<_>>();

    ranked.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(Ordering::Equal)
            .then(left.1.cmp(&right.1))
    });

    let mut selected = BTreeSet::new();
    if is_title_candidate(utterances.first()) {
        selected.insert(0usize);
    }

    for (_, index) in ranked {
        if selected.len() >= target_count {
            break;
        }

        selected.insert(index);
    }

    if selected.is_empty() {
        return utterances.iter().take(target_count).cloned().collect();
    }

    selected
        .into_iter()
        .take(target_count)
        .map(|index| utterances[index].clone())
        .collect()
}

fn summary_target_count(total_utterances: usize) -> usize {
    match total_utterances {
        0..=3 => total_utterances,
        4..=8 => 4,
        9..=16 => 4,
        _ => 5,
    }
}

fn score_tokens(utterances: &[Utterance]) -> HashMap<String, f32> {
    let mut scores = HashMap::new();

    for utterance in utterances {
        for token in significant_tokens(&utterance.text) {
            *scores.entry(token).or_insert(0.0) += 1.0;
        }
    }

    scores
}

fn score_utterance(
    index: usize,
    utterance: &Utterance,
    total_utterances: usize,
    token_scores: &HashMap<String, f32>,
) -> f32 {
    let text = utterance.text.trim();
    if text.is_empty() {
        return 0.0;
    }

    let heading_like = is_heading_like(text);
    if heading_like && index != 0 {
        return 0.0;
    }

    let tokens = significant_tokens(text);
    let mut score = if tokens.is_empty() {
        if index == 0 { 1.0 } else { 0.0 }
    } else {
        tokens
            .iter()
            .map(|token| token_scores.get(token).copied().unwrap_or_default())
            .sum::<f32>()
            / tokens.len() as f32
    };

    if index == 0 {
        score += 1.8;
    } else if index <= 2 {
        score += 0.8;
    } else if index < total_utterances / 3 {
        score += 0.3;
    }

    if index + 1 == total_utterances {
        score += 0.6;
    } else if index + 2 == total_utterances {
        score += 0.2;
    }

    if text.starts_with("Done:") || text.starts_with("To do:") {
        score += 0.2;
    }

    if text.len() < 28 && !heading_like {
        score *= 0.75;
    }

    if text.len() > 260 {
        score *= 0.85;
    }

    score
}

fn significant_tokens(text: &str) -> Vec<String> {
    tokenize(text)
        .into_iter()
        .filter(|token| token.len() >= 4)
        .filter(|token| !is_stop_word(token))
        .collect()
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for character in text.chars() {
        if character.is_alphanumeric() {
            current.extend(character.to_lowercase());
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn is_stop_word(token: &str) -> bool {
    ENGLISH_STOP_WORDS.contains(&token) || SPANISH_STOP_WORDS.contains(&token)
}

fn is_heading_like(text: &str) -> bool {
    !text.ends_with(['.', '!', '?', ';', ':'])
        && text.split_whitespace().count() <= 8
        && text.len() <= 70
}

fn is_title_candidate(utterance: Option<&Utterance>) -> bool {
    utterance.is_some_and(|utterance| is_heading_like(utterance.text.trim()))
}

#[cfg(test)]
mod tests {
    use super::summarize_utterances;
    use crate::markdown::Utterance;

    #[test]
    fn keeps_short_documents_intact() {
        let utterances = vec![
            utterance("Title", 0),
            utterance("Important context about the file.", 10),
            utterance("Another important point for the summary.", 40),
        ];

        let summary = summarize_utterances(&utterances);
        assert_eq!(summary.len(), 3);
        assert_eq!(summary[0].text, "Title");
    }

    #[test]
    fn prefers_high_signal_sentences_and_preserves_document_order() {
        let utterances = vec![
            utterance("Project Overview", 0),
            utterance("This extension reads Markdown files aloud with local neural speech.", 20),
            utterance("The Rust parser prepares utterances and keeps document offsets for playback.", 90),
            utterance("A minor aside about internal experiments that is not important.", 180),
            utterance("Cursor and VS Code both use the same packaged extension.", 250),
            utterance("The summary mode should play the most important parts first.", 320),
        ];

        let summary = summarize_utterances(&utterances);
        let texts = summary.iter().map(|utterance| utterance.text.as_str()).collect::<Vec<_>>();

        assert_eq!(texts[0], "Project Overview");
        assert!(texts.contains(&"This extension reads Markdown files aloud with local neural speech."));
        assert!(texts.contains(&"The Rust parser prepares utterances and keeps document offsets for playback."));
        assert!(texts.contains(&"The summary mode should play the most important parts first."));
        assert!(!texts.contains(&"A minor aside about internal experiments that is not important."));
    }

    fn utterance(text: &str, start_offset: usize) -> Utterance {
        Utterance {
            text: text.to_string(),
            start_offset,
            end_offset: start_offset + text.len(),
        }
    }
}
