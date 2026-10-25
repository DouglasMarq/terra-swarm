pub(crate) fn reorder_by_ids<T>(
    items: Vec<T>,
    order: &[String],
    id_of: impl Fn(&T) -> &str,
) -> Vec<T> {
    let mut remaining = items;
    let mut sorted = Vec::with_capacity(remaining.len());
    for id in order {
        if let Some(position) = remaining.iter().position(|item| id_of(item) == id) {
            sorted.push(remaining.remove(position));
        }
    }
    sorted.extend(remaining);
    sorted
}

pub(crate) fn add_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}
