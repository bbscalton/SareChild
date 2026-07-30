package com.sarechild.shared

/**
 * On-device risk scoring: keyword matching plus leetspeak normalization and pattern heuristics.
 * No network ML — suitable for Play/policy and offline use.
 */
class RiskClassifier(
    private val keywordMatcher: KeywordMatcher = KeywordMatcher()
) {
    data class Assessment(
        val score: Int,
        val severity: AlertSeverity,
        val hits: List<KeywordHit>,
        val reasons: List<String>
    )

    fun assess(text: String): Assessment {
        if (text.isBlank()) {
            return Assessment(0, AlertSeverity.LOW, emptyList(), emptyList())
        }
        val normalized = normalize(text)
        val hits = keywordMatcher.findHits(normalized).toMutableList()
        val reasons = mutableListOf<String>()
        var score = hits.sumOf { categoryWeight(it.category) }

        PATTERN_RULES.forEach { rule ->
            if (rule.regex.containsMatchIn(normalized)) {
                score += rule.weight
                reasons += rule.label
                if (hits.none { it.category == rule.category }) {
                    hits += KeywordHit(rule.category, rule.label, rule.regex.find(normalized)?.value ?: "")
                }
            }
        }

        val severity = when {
            score >= 80 -> AlertSeverity.CRITICAL
            score >= 50 -> AlertSeverity.HIGH
            score >= 25 -> AlertSeverity.MEDIUM
            score > 0 -> AlertSeverity.LOW
            else -> AlertSeverity.LOW
        }
        return Assessment(score.coerceIn(0, 100), severity, hits.distinctBy { it.category to it.phrase }, reasons)
    }

    companion object {
        private data class PatternRule(
            val label: String,
            val category: KeywordCategory,
            val weight: Int,
            val regex: Regex
        )

        private val PATTERN_RULES = listOf(
            PatternRule(
                "secrecy pressure",
                KeywordCategory.GROOMING,
                35,
                Regex("(?i)(delete (this|the) (chat|message)|screenshot|don't tell|dont tell|our little secret|no one (can|should) know)")
            ),
            PatternRule(
                "meet offline alone",
                KeywordCategory.GROOMING,
                40,
                Regex("(?i)(meet (me|up) (alone|in person|at night)|come over when (they|parents) (are|aren't) home)")
            ),
            PatternRule(
                "age probing",
                KeywordCategory.GROOMING,
                30,
                Regex("(?i)(how old are you|what age|are you (really )?\\d{1,2}|underage|minor)")
            ),
            PatternRule(
                "self-harm ideation",
                KeywordCategory.SELF_HARM,
                45,
                Regex("(?i)(want to (die|hurt myself)|end (it|my life)|can't go on|no reason to live)")
            ),
            PatternRule(
                "drug solicitation",
                KeywordCategory.DRUGS,
                30,
                Regex("(?i)(sell (you )?weed|plug|xanax|perc|molly|buy pills|drug dealer)")
            ),
            PatternRule(
                "violence threat",
                KeywordCategory.VIOLENCE,
                40,
                Regex("(?i)(kill you|shoot (you|them)|stab|bring (a )?(knife|gun)|fight after school)")
            ),
            PatternRule(
                "sexual solicitation",
                KeywordCategory.SEX,
                35,
                Regex("(?i)(send (me )?(nudes|pics)|trade pics|show (me )?(your )?body|onlyfans|snap (nudes|pics))")
            )
        )

        fun normalize(raw: String): String {
            var s = raw.lowercase()
            s = s.replace(Regex("[\\u200B-\\u200D\\uFEFF]"), "")
            val leet = mapOf(
                '0' to 'o', '1' to 'i', '3' to 'e', '4' to 'a', '5' to 's',
                '7' to 't', '@' to 'a', '$' to 's'
            )
            val sb = StringBuilder(s.length)
            for (c in s) {
                sb.append(leet[c] ?: c)
            }
            s = sb.toString()
            s = s.replace(Regex("""(.)\1{2,}"""), "$1$1")
            return s.replace('\n', ' ').trim()
        }

        private fun categoryWeight(cat: KeywordCategory): Int = when (cat) {
            KeywordCategory.SELF_HARM -> 40
            KeywordCategory.GROOMING -> 35
            KeywordCategory.VIOLENCE -> 30
            KeywordCategory.SEX -> 25
            KeywordCategory.DRUGS -> 20
            KeywordCategory.OTHER -> 10
        }
    }
}
