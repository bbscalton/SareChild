package com.sarechild.shared

/**
 * On-device keyword matcher. Word-boundary aware where possible.
 * Prefer alert hits over storing full message bodies.
 */
class KeywordMatcher(
    private val phrasesByCategory: Map<KeywordCategory, List<String>> = DefaultKeywords.lists
) {
    data class Compiled(
        val category: KeywordCategory,
        val phrase: String,
        val regex: Regex
    )

    private val compiled: List<Compiled> = phrasesByCategory.flatMap { (cat, phrases) ->
        phrases.mapNotNull { phrase ->
            val trimmed = phrase.trim()
            if (trimmed.isEmpty()) null
            else Compiled(
                category = cat,
                phrase = trimmed,
                regex = Regex("""(?i)(?<!\w)${Regex.escape(trimmed)}(?!\w)""")
            )
        }
    }

    fun findHits(text: String): List<KeywordHit> {
        if (text.isBlank()) return emptyList()
        val normalized = text.replace('\n', ' ').trim()
        return compiled.mapNotNull { c ->
            val match = c.regex.find(normalized) ?: return@mapNotNull null
            KeywordHit(
                category = c.category,
                phrase = c.phrase,
                matchedText = match.value
            )
        }.distinctBy { it.category to it.phrase.lowercase() }
    }

    companion object {
        fun fromFirestoreMap(map: Map<String, Any?>?): KeywordMatcher {
            if (map == null) return KeywordMatcher()
            val categories = mutableMapOf<KeywordCategory, List<String>>()
            KeywordCategory.entries.forEach { cat ->
                val key = cat.name.lowercase()
                @Suppress("UNCHECKED_CAST")
                val list = (map[key] as? List<*>)?.mapNotNull { it as? String }
                    ?: (map[cat.name] as? List<*>)?.mapNotNull { it as? String }
                if (!list.isNullOrEmpty()) {
                    categories[cat] = list
                }
            }
            return if (categories.isEmpty()) KeywordMatcher() else KeywordMatcher(categories)
        }
    }
}

object DefaultKeywords {
    val lists: Map<KeywordCategory, List<String>> = mapOf(
        KeywordCategory.SEX to listOf(
            "sex", "nude", "nudes", "naked", "porn", "onlyfans", "send pics", "send nudes"
        ),
        KeywordCategory.DRUGS to listOf(
            "weed", "cocaine", "heroin", "fentanyl", "meth", "ecstasy", "molly", "buy drugs", "dealer"
        ),
        KeywordCategory.GROOMING to listOf(
            "don't tell your parents", "dont tell your parents", "keep this secret",
            "our secret", "meet me alone", "send me a photo", "how old are you really"
        ),
        KeywordCategory.SELF_HARM to listOf(
            "kill myself", "suicide", "self harm", "self-harm", "want to die", "cutting myself"
        ),
        KeywordCategory.VIOLENCE to listOf(
            "bring a knife", "bring a gun", "shoot up", "beat you up"
        )
    )
}
